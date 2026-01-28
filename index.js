require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors(), express.json(), express.static("public"));

const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");
let adminWaitList = new Set(); 
let ratioWaitList = new Set(); // ✅ เรเพิ่ม List สำหรับรอกรอกอัตราส่วนค่ะ

/* ============================================================
   1. API SYSTEM (HMI & LIFF)
============================================================ */

// API สร้าง QR (สำหรับตู้ HMI) - ดึงอัตราส่วนจาก DB มาคำนวณ
app.post("/create-qr", async (req, res) => {
    try {
        const { amount, machine_id } = req.body;
        
        // 💰 ดึงอัตราส่วนล่าสุดจาก DB (ถ้าไม่มีให้ใช้ 10:1 เป็นค่าพื้นฐาน)
        const { data: config } = await supabase.from("system_configs").select("*").eq("config_key", "exchange_ratio").maybeSingle();
        const baht_rate = config ? config.baht_val : 10;
        const point_rate = config ? config.point_val : 1;

        // คำนวณแต้มตามอัตราส่วนที่กำหนด
        const point_get = Math.floor((amount / baht_rate) * point_rate); 
        const token = crypto.randomUUID();

        const { error } = await supabase.from("qrPointToken").insert({
            qr_token: token,
            point_get: point_get,
            machine_id: machine_id,
            scan_amount: amount, 
            is_used: false,
            create_at: new Date().toISOString() 
        });

        if (error) throw error;
        const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}?token=${token}`;
        res.json({ success: true, qr_url: liffUrl, points: point_get, token: token });
    } catch (e) {
        console.error("Create QR Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// API ดึงยอดแต้ม (สำหรับหน้า LIFF)
app.get("/api/get-user-points", async (req, res) => {
    const { userId } = req.query;
    try {
        const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
        if (!m) return res.json({ points: 0 });
        const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).maybeSingle();
        res.json({ points: w?.point_balance || 0 });
    } catch (e) { res.status(500).json({ points: 0 }); }
});

// API สะสมแต้ม (LIFF Consume)
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    const { data: qrData } = await supabase.from("qrPointToken").select("*").eq("qr_token", token).maybeSingle();
    
    if (!qrData || qrData.is_used) return res.status(400).send("QR Invalid");
    
    await supabase.from("qrPointToken").update({ 
        is_used: true, 
        used_by: userId, 
        used_at: new Date().toISOString() 
    }).eq("qr_token", token);
    
    let { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
    if (!member) { 
        const { data: newMember } = await supabase.from("ninetyMember").insert({ line_user_id: userId }).select().single();
        member = newMember;
    }
    
    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).maybeSingle();
    const newTotal = (wallet?.point_balance || 0) + qrData.point_get;
    await supabase.from("memberWallet").upsert({ member_id: member.id, point_balance: newTotal }, { onConflict: 'member_id' });
    
    await sendReplyPush(userId, `✨ สะสมสำเร็จ! +${qrData.point_get} แต้ม (รวม: ${newTotal})`);
    res.send("SUCCESS");
  } catch (err) { res.status(500).send(err.message); }
});

// API แลกแต้ม (LIFF Redeem)
app.get("/liff/redeem-execute", async (req, res) => {
  try {
    let { userId, amount, machine_id } = req.query;
    if (machine_id?.includes("machine_id=")) machine_id = machine_id.split("machine_id=")[1].split("&")[0];
    
    const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).maybeSingle();
    
    if (!w || w.point_balance < amount) return res.status(400).send("แต้มไม่พอ");
    
    const newBalance = w.point_balance - amount;
    await supabase.from("memberWallet").update({ point_balance: newBalance }).eq("member_id", m.id);
    await supabase.from("redeemlogs").insert({ member_id: m.id, machine_id, points_redeemed: parseInt(amount), status: "pending" });
    
    await sendReplyPush(userId, `✅ แลกสำเร็จ! -${amount} แต้ม (เหลือ: ${newBalance})`);
    res.send(`SUCCESS: MACHINE_${machine_id}_START`);
  } catch (err) { res.status(500).send(err.message); }
});

/* ============================================================
   2. WEBHOOK & BOT LOGIC
============================================================ */
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  for (let event of events) {
    const userId = event.source.userId;
    const isUserAdmin = await isAdmin(userId);

    if (event.type !== "message" || event.message.type !== "text") continue;

    const rawMsg = event.message.text.trim();
    const userMsg = rawMsg.toUpperCase();

    try {
      if (userMsg === "USER_LINE") return await sendReply(event.replyToken, `ID: ${userId}`);
      
      // --- Admin Flow ---
      if (isUserAdmin) {
        // ✅ ดักจับการกรอก บาท:แต้ม
        if (ratioWaitList.has(userId)) {
            ratioWaitList.delete(userId);
            return await updateExchangeRatio(rawMsg, event.replyToken);
        }

        if (adminWaitList.has(userId)) {
          adminWaitList.delete(userId);
          return await addNewAdmin(rawMsg, event.replyToken);
        }
        
        if (userMsg === "ADMIN") return await sendAdminDashboard(event.replyToken);
        if (userMsg === "MANAGE_ADMIN") return await sendManageAdminFlex(event.replyToken);
        if (userMsg === "REPORT") return await listCombinedReport(event.replyToken);
        if (userMsg === "LIST_ADMIN") return await listAdminsWithDelete(event.replyToken);
        
        // ✅ คำสั่งเมนูที่ 3: เริ่มกระบวนการตั้งค่าอัตราส่วน
        if (userMsg === "SET_RATIO_STEP1") {
            ratioWaitList.add(userId);
            return await sendReply(event.replyToken, "📊 ระบุ บาท:แต้ม ที่ต้องการกำหนดได้เลยค่ะ\n(เช่น พิมพ์ 10:1 หมายถึง 10 บาท ได้ 1 แต้ม)");
        }

        if (userMsg === "ADD_ADMIN_STEP1") { 
            adminWaitList.add(userId); 
            return await sendReply(event.replyToken, "🆔 ส่ง ID เว้นวรรคตามด้วยชื่อมาได้เลยค่ะ"); 
        }
        if (userMsg.startsWith("DEL_ADMIN_ID ")) return await deleteAdmin(rawMsg.split(" ")[1], event.replyToken);
        if (userMsg.startsWith("APPROVE_ID ")) return await approveSpecificPoint(rawMsg.split(" ")[1], event.replyToken);
      }
      
      // --- User Flow (Request Points) ---
      const pointMatch = rawMsg.match(/^(\d+)\s*(แต้ม|คะแนน|p|point|pts)?$/i);
      if (pointMatch) {
          const points = parseInt(pointMatch[1]);
          if (points > 0) {
              const { error } = await supabase.from("point_requests").insert({
                  line_user_id: userId,
                  points: points,
                  request_at: new Date().toISOString()
              });
              if (!error) {
                  return await sendReply(event.replyToken, `📝 รับทราบค่ะ! ส่งคำขอ ${points} แต้ม ให้แอดมินแล้ว\nกรุณารอการอนุมัตินะคะ ✨`);
              }
          }
      }

      if (userMsg === "CHECK_POINT") {
          const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
          if (member) {
             const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).maybeSingle();
             await sendReply(event.replyToken, `🌟 ยอดแต้มของคุณ: ${w?.point_balance || 0} แต้ม`);
          } else {
             await sendReply(event.replyToken, "คุณยังไม่มีข้อมูลในระบบค่ะ ลองใช้งานที่ร้านก่อนนะคะ");
          }
      }

    } catch (e) { console.error("Webhook Error:", e); }
  }
  res.sendStatus(200);
});

/* ============================================================
   3. HELPERS & DB LOGIC
============================================================ */

// ✅ ฟังก์ชันอัปเดตอัตราส่วน (บาท:แต้ม)
async function updateExchangeRatio(input, rt) {
    const parts = input.split(":");
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
        return await sendReply(rt, "❌ รูปแบบผิด! กรุณาพิมพ์ ตัวเลข:ตัวเลข เช่น 10:1 ค่ะ");
    }
    const baht = parseInt(parts[0]);
    const point = parseInt(parts[1]);

    await supabase.from("system_configs").upsert({
        config_key: "exchange_ratio",
        baht_val: baht,
        point_val: point,
        updated_at: new Date().toISOString()
    }, { onConflict: 'config_key' });

    await sendReply(rt, `✅ ตั้งค่าสำเร็จ!\nตอนนี้คือ ${baht} บาท ต่อ ${point} แต้มค่ะ`);
}

async function isAdmin(uid) { 
    if(!uid) return false;
    const { data } = await supabase.from("bot_admins").select("line_user_id").eq("line_user_id", uid).maybeSingle(); 
    return !!data; 
}

async function addNewAdmin(input, rt) {
  const parts = input.split(/\s+/);
  const tid = parts[0];
  const name = parts.slice(1).join(" ") || "Admin_New";
  if (!tid.startsWith("U") || tid.length < 30) return await sendReply(rt, "❌ ID ผิดพลาด");
  await supabase.from("bot_admins").upsert({ line_user_id: tid, admin_name: name }, { onConflict: 'line_user_id' });
  await sendReply(rt, `✅ เพิ่มแอดมิน: ${name} สำเร็จ!`);
}

async function deleteAdmin(tid, rt) {
  const { data: adms } = await supabase.from("bot_admins").select("id");
  if (adms.length <= 1) return await sendReply(rt, "⚠️ ลบไม่ได้! ต้องเหลือแอดมินอย่างน้อย 1 คน");
  await supabase.from("bot_admins").delete().eq("line_user_id", tid);
  await sendReply(rt, "🗑️ ลบเรียบร้อย");
}

async function approveSpecificPoint(rid, rt) {
  const { data: req } = await supabase.from("point_requests").select("*").eq("id", rid).maybeSingle();
  if (!req) return await sendReply(rt, "❌ รายการนี้อาจถูกอนุมัติไปแล้ว");
  
  let { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", req.line_user_id).maybeSingle();
  if (!m) { m = (await supabase.from("ninetyMember").insert({ line_user_id: req.line_user_id }).select().single()).data; }

  const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).maybeSingle();
  const newTotal = (w?.point_balance || 0) + req.points;
  
  await supabase.from("memberWallet").upsert({ member_id: m.id, point_balance: newTotal }, { onConflict: 'member_id' });
  await supabase.from("point_requests").delete().eq("id", req.id);
  
  await sendReply(rt, `✅ อนุมัติ ${req.points} แต้ม สำเร็จ!`);
  await sendReplyPush(req.line_user_id, `🎊 แอดมินเติมแต้มให้ ${req.points} แต้มแล้วค่ะ (ยอดรวม: ${newTotal})`);
}

/* ============================================================
   4. UI DASHBOARD & REPORT
============================================================ */

async function sendAdminDashboard(replyToken) {
  const flex = { 
      type: "bubble", 
      header: { type: "box", layout: "vertical", backgroundColor: "#1c1c1c", contents: [{ type: "text", text: "NINETY God Mode", color: "#00b900", weight: "bold", size: "xl" }] }, 
      body: { type: "box", layout: "vertical", spacing: "md", contents: [
          { type: "button", style: "primary", color: "#333333", action: { type: "message", label: "⚙️ MANAGE ADMIN", text: "MANAGE_ADMIN" } }, 
          { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📊 ACTIVITY REPORT", text: "REPORT" } },
          // ✅ ปุ่มที่ 3: ตั้งค่าอัตราส่วน
          { type: "button", style: "primary", color: "#ff9f00", action: { type: "message", label: "💰 SET EXCHANGE RATIO", text: "SET_RATIO_STEP1" } }
      ]} 
  };
  await sendFlex(replyToken, "God Mode", flex);
}

async function sendManageAdminFlex(replyToken) {
  const flex = { 
      type: "bubble", 
      body: { type: "box", layout: "vertical", spacing: "md", contents: [
          { type: "text", text: "⚙️ ADMIN SETTINGS", weight: "bold", size: "lg" }, 
          { type: "button", style: "secondary", action: { type: "message", label: "📋 LIST & REMOVE ADMIN", text: "LIST_ADMIN" } }, 
          { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "➕ ADD NEW ADMIN", text: "ADD_ADMIN_STEP1" } }
      ]} 
  };
  await sendFlex(replyToken, "Admin Settings", flex);
}

async function listAdminsWithDelete(replyToken) {
  try {
      const { data: adms } = await supabase.from("bot_admins").select("*");
      if (!adms || adms.length === 0) return await sendReply(replyToken, "❌ ไม่พบข้อมูลแอดมิน");
      const adminRows = adms.map(a => ({ type: "box", layout: "horizontal", margin: "sm", contents: [{ type: "text", text: `👤 ${a.admin_name || 'Admin'}`, size: "xs", gravity: "center", flex: 3 }, { type: "button", style: "primary", color: "#ff4b4b", height: "sm", flex: 2, action: { type: "message", label: "🗑️ REMOVE", text: `DEL_ADMIN_ID ${a.line_user_id}` } }] }));
      await sendFlex(replyToken, "Admin List", { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "🔐 ADMIN LIST", weight: "bold" }, ...adminRows] } });
  } catch(e) { await sendReply(replyToken, "❌ Error: " + e.message); }
}

async function listCombinedReport(replyToken) {
  try {
    const { data: pending } = await supabase.from("point_requests").select("*").limit(3).order("request_at", { ascending: false });
    const { data: earns } = await supabase.from("qrPointToken").select("*").eq("is_used", true).not("used_at", "is", null).order("used_at", { ascending: false }).limit(5);
    const { data: redeems } = await supabase.from("redeemlogs").select("*").limit(5).order("created_at", { ascending: false });
    const formatTime = (isoStr) => isoStr ? new Date(isoStr).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : "--:--";
    const flex = {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md", contents: [
        { type: "text", text: "📊 ACTIVITY REPORT", weight: "bold", color: "#00b900", size: "lg" },
        { type: "text", text: "🔔 PENDING", weight: "bold", size: "xs", color: "#ff4b4b" },
        { type: "box", layout: "vertical", contents: (pending?.length > 0) ? pending.map(r => ({ type: "box", layout: "horizontal", margin: "xs", contents: [{ type: "text", text: `+${r.points}p [${r.line_user_id.substring(0, 6)}..]`, size: "xxs", gravity: "center", flex: 3 }, { type: "button", style: "primary", color: "#00b900", height: "sm", flex: 2, action: { type: "message", label: "OK", text: `APPROVE_ID ${r.id}` } }] })) : [{ type: "text", text: "-", size: "xxs", color: "#aaaaaa" }] },
        { type: "separator" },
        { type: "text", text: "📥 RECENT EARNS", weight: "bold", size: "xs", color: "#00b900" },
        { type: "box", layout: "vertical", spacing: "xs", contents: (earns?.length > 0) ? earns.map(e => ({ type: "text", text: `• [${e.machine_id || '??'}] | ${e.used_by ? e.used_by.substring(0,6) : '-'} | +${e.point_get}p (${e.scan_amount || 0}฿) | ${formatTime(e.used_at)}`, size: "xxs", color: "#333333" })) : [{ type: "text", text: "-", size: "xxs" }] },
        { type: "separator" },
        { type: "text", text: "📤 RECENT REDEEMS", weight: "bold", size: "xs", color: "#ff9f00" },
        { type: "box", layout: "vertical", spacing: "xs", contents: (redeems?.length > 0) ? redeems.map(u => ({ type: "text", text: `• [${u.machine_id || '??'}] | ${u.member_id?.toString().substring(0,6) || '?'} | -${u.points_redeemed}p | ${formatTime(u.created_at)}`, size: "xxs", color: "#333333" })) : [{ type: "text", text: "-", size: "xxs" }] }
      ]}
    };
    await sendFlex(replyToken, "Activity Report", flex);
  } catch (e) { await sendReply(replyToken, "❌ Report Error: " + e.message); }
}

/* ============================================================
   5. MESSAGE SENDER
============================================================ */
async function sendReply(rt, text) { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }
async function sendReplyPush(to, text) { await axios.post("https://api.line.me/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }
async function sendFlex(rt, altText, contents) { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "flex", altText, contents }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 God Mode on port ${PORT}`));
