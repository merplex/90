require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors(), express.json(), express.static("public"));

const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");
let adminWaitList = new Set(); 

/* ====================================
   1. API สำหรับ LIFF (สำคัญมาก: ห้ามลบ)
==================================== */

// ✅ [เพิ่มกลับมาแล้ว] API ดึงยอดแต้มปัจจุบัน (แก้ปัญหาแต้มเป็น 0)
app.get("/api/get-user-points", async (req, res) => {
    const { userId } = req.query;
    try {
        const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
        if (!m) return res.json({ points: 0 });
        const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
        res.json({ points: w?.point_balance || 0 });
    } catch (e) { 
        res.status(500).json({ points: 0 }); 
    }
});

app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    const { data: qrData } = await supabase.from("qrPointToken").select("*").eq("qr_token", token).single();
    if (!qrData || qrData.is_used) return res.status(400).send("QR Invalid");
    
    // บันทึก used_by เป็น userId ที่สแกน
    await supabase.from("qrPointToken").update({ is_used: true, used_by: userId, used_at: new Date().toISOString() }).eq("qr_token", token);
    
    let { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
    if (!member) { member = (await supabase.from("ninetyMember").insert({ line_user_id: userId }).select().single()).data; }
    
    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
    const newTotal = (wallet?.point_balance || 0) + qrData.point_get;
    await supabase.from("memberWallet").upsert({ member_id: member.id, point_balance: newTotal }, { onConflict: 'member_id' });
    
    await sendReplyPush(userId, `✨ สะสมสำเร็จ! +${qrData.point_get} แต้ม (รวม: ${newTotal})`);
    res.send("SUCCESS");
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/liff/redeem-execute", async (req, res) => {
  try {
    let { userId, amount, machine_id } = req.query;
    if (machine_id?.includes("machine_id=")) machine_id = machine_id.split("machine_id=")[1].split("&")[0];
    const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
    if (w.point_balance < amount) return res.status(400).send("แต้มไม่พอ");
    
    const newBalance = w.point_balance - amount;
    await supabase.from("memberWallet").update({ point_balance: newBalance }).eq("member_id", m.id);
    await supabase.from("redeemlogs").insert({ member_id: m.id, machine_id, points_redeemed: parseInt(amount), status: "pending" });
    
    await sendReplyPush(userId, `✅ แลกสำเร็จ! -${amount} แต้ม (เหลือ: ${newBalance})`);
    res.send(`SUCCESS: MACHINE_${machine_id}_START`);
  } catch (err) { res.status(500).send(err.message); }
});

/* ====================================
   2. WEBHOOK & GOD MODE DASHBOARD
==================================== */
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
      if (isUserAdmin) {
        if (adminWaitList.has(userId)) {
          adminWaitList.delete(userId);
          return await addNewAdmin(rawMsg, event.replyToken);
        }
        
        // --- ⚡ ADMIN COMMANDS ---
        if (userMsg === "ADMIN") return await sendAdminDashboard(event.replyToken);
        if (userMsg === "MANAGE_ADMIN") return await sendManageAdminFlex(event.replyToken);
        if (userMsg === "REPORT") return await listCombinedReport(event.replyToken);
        if (userMsg === "LIST_ADMIN") return await listAdminsWithDelete(event.replyToken);
        if (userMsg === "ADD_ADMIN_STEP1") { 
            adminWaitList.add(userId); 
            return await sendReply(event.replyToken, "🆔 ส่ง ID เว้นวรรคตามด้วยชื่อมาได้เลยค่ะ (เช่น: U123... Boss เปรม)"); 
        }
        if (userMsg.startsWith("DEL_ADMIN_ID ")) return await deleteAdmin(rawMsg.split(" ")[1], event.replyToken);
        if (userMsg.startsWith("APPROVE_ID ")) return await approveSpecificPoint(rawMsg.split(" ")[1], event.replyToken);
      }
      
      // --- 👤 USER COMMANDS ---
      const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
      if (member) {
        if (userMsg === "CHECK_POINT") {
          const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
          await sendReply(event.replyToken, `🌟 ยอดแต้มของคุณ: ${w?.point_balance || 0} แต้ม`);
        }
      }
    } catch (e) { console.error(e.message); }
  }
  res.sendStatus(200);
});

/* ====================================
   3. UI COMPONENTS (GOD MODE STYLE)
==================================== */

// Dashboard หน้าหลัก (สีดำ-เขียว ดูโปร)
async function sendAdminDashboard(replyToken) {
  const flex = { 
      type: "bubble", 
      header: { type: "box", layout: "vertical", backgroundColor: "#1c1c1c", contents: [{ type: "text", text: "NINETY God Mode", color: "#00b900", weight: "bold", size: "xl" }] }, 
      body: { type: "box", layout: "vertical", spacing: "md", contents: [
          { type: "button", style: "primary", color: "#333333", action: { type: "message", label: "⚙️ MANAGE ADMIN", text: "MANAGE_ADMIN" } }, 
          { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📊 ACTIVITY REPORT", text: "REPORT" } }
      ]} 
  };
  await sendFlex(replyToken, "God Mode", flex);
}

// หน้าจัดการแอดมิน
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

// รายชื่อแอดมิน (แก้บัคไม่ขึ้น)
async function listAdminsWithDelete(replyToken) {
  try {
      const { data: adms } = await supabase.from("bot_admins").select("*");
      if (!adms || adms.length === 0) return await sendReply(replyToken, "❌ ไม่พบข้อมูลแอดมินในระบบ");

      const isOnlyOne = adms.length <= 1;
      const adminRows = adms.map(a => ({
        type: "box", layout: "horizontal", margin: "sm", contents: [
          { type: "text", text: `👤 ${a.admin_name || 'No Name'}`, size: "xs", gravity: "center", flex: 3 },
          !isOnlyOne 
            ? { type: "button", style: "primary", color: "#ff4b4b", height: "sm", flex: 2, action: { type: "message", label: "🗑️ REMOVE", text: `DEL_ADMIN_ID ${a.line_user_id}` } } 
            : { type: "text", text: "👑 (Last)", size: "xxs", color: "#aaaaaa", gravity: "center", align: "end", flex: 2 }
        ]
      }));
      
      const flex = { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "🔐 ADMIN LIST", weight: "bold" }, ...adminRows] } };
      await sendFlex(replyToken, "Admin List", flex);
  } catch(e) { await sendReply(replyToken, "❌ Error loading list: " + e.message); }
}

// รายงานความเคลื่อนไหว (แก้บัค Guest/Undefined)
async function listCombinedReport(replyToken) {
  try {
    const { data: pending } = await supabase.from("point_requests").select("*").limit(3).order("request_at", { ascending: false });
    const { data: earns } = await supabase.from("qrPointToken").select("*").limit(5).order("used_at", { ascending: false });
    const { data: redeems } = await supabase.from("redeemlogs").select("*").limit(5).order("created_at", { ascending: false });

    const formatTime = (isoStr) => isoStr ? new Date(isoStr).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : "--:--";

    const flex = {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md", contents: [
        { type: "text", text: "📊 ACTIVITY REPORT", weight: "bold", color: "#00b900", size: "lg" },
        
        // PENDING
        { type: "text", text: "🔔 PENDING", weight: "bold", size: "xs", color: "#ff4b4b" },
        { type: "box", layout: "vertical", contents: (pending?.length > 0) ? pending.map(r => ({
          type: "box", layout: "horizontal", margin: "xs", contents: [
            { type: "text", text: `+${r.points} pts [..${r.line_user_id.slice(-5)}]`, size: "xxs", gravity: "center", flex: 3 },
            { type: "button", style: "primary", color: "#00b900", height: "sm", flex: 2, action: { type: "message", label: "OK", text: `APPROVE_ID ${r.id}` } }
          ]
        })) : [{ type: "text", text: "-", size: "xxs", color: "#aaaaaa" }] },
        
        { type: "separator" },
        
        // RECENT EARNS (ใช้ used_by ตรงๆ)
        { type: "text", text: "📥 RECENT EARNS", weight: "bold", size: "xs", color: "#00b900" },
        { type: "box", layout: "vertical", spacing: "xs", contents: (earns?.length > 0) ? earns.map(e => ({
          // ถ้า used_by ไม่มีค่า (null) ให้โชว์เป็น "-" แทน
          type: "text", text: `• [${e.machine_id || '??'}] | ${e.used_by ? e.used_by.substring(0,5) : '-'} | +${e.point_get} pts | ${formatTime(e.used_at)}`, size: "xxs", color: "#333333"
        })) : [{ type: "text", text: "-", size: "xxs" }] },
        
        { type: "separator" },
        
        // RECENT REDEEMS
        { type: "text", text: "📤 RECENT REDEEMS", weight: "bold", size: "xs", color: "#ff9f00" },
        { type: "box", layout: "vertical", spacing: "xs", contents: (redeems?.length > 0) ? redeems.map(u => ({
          type: "text", text: `• [${u.machine_id || '??'}] | ${u.member_id?.toString().slice(-4) || '?'} | -${u.points_redeemed} pts | ${formatTime(u.created_at)}`, size: "xxs", color: "#333333"
        })) : [{ type: "text", text: "-", size: "xxs" }] }
      ]}
    };
    await sendFlex(replyToken, "Activity Report", flex);
  } catch (e) { await sendReply(replyToken, "❌ Report Error: " + e.message); }
}

/* ====================================
   4. HELPERS
==================================== */
async function isAdmin(uid) { 
    if(!uid) return false;
    const { data } = await supabase.from("bot_admins").select("line_user_id").eq("line_user_id", uid).single(); 
    return !!data; 
}

async function addNewAdmin(input, rt) {
  const parts = input.split(/\s+/);
  const tid = parts[0];
  const name = parts.slice(1).join(" ") || "Admin_New";
  if (!tid.startsWith("U") || tid.length < 30) return await sendReply(rt, "❌ ID ผิดพลาด (ต้องขึ้นต้นด้วย U)");
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
  const { data: req } = await supabase.from("point_requests").select("*").eq("id", rid).single();
  if (!req) return;
  const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", req.line_user_id).single();
  const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
  const newTotal = (w?.point_balance || 0) + req.points;
  await supabase.from("memberWallet").upsert({ member_id: m.id, point_balance: newTotal }, { onConflict: 'member_id' });
  await supabase.from("point_requests").delete().eq("id", req.id);
  await sendReply(rt, `✅ อนุมัติสำเร็จ!`);
}

async function sendReply(rt, text) { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }
async function sendFlex(rt, altText, contents) { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "flex", altText, contents }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 God Mode on port ${PORT}`));
