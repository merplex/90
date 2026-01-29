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
let ratioWaitList = new Set();

/* ============================================================
   1. API SYSTEM (HMI & LIFF)
============================================================ */

// ✨ [เพิ่มใหม่] API สำหรับดึงรายงานไปโชว์ใน LIFF (20 รายการ)
app.get("/api/get-report", async (req, res) => {
    let { type, limit, targetUser } = req.query;
    limit = parseInt(limit) || 20;
    
    try {
        let results = [];
        const formatTime = (iso) => iso ? new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : "--:--";

        // 1. ดึงข้อมูล Pending (จาก point_requests)
        if (type === 'pending' || type === 'all') {
            let q = supabase.from("point_requests").select("*").order("request_at", { ascending: false }).limit(limit);
            if (targetUser) q = q.eq("line_user_id", targetUser);
            const { data } = await q;
            (data || []).forEach(i => results.push({ machine_id: '-', line_user_id: i.line_user_id, amount: i.points, time: formatTime(i.request_at), raw_time: i.request_at, type: 'pending' }));
        }

        // 2. ดึงข้อมูล Earn (จาก qrPointToken)
        if (type === 'earn' || type === 'all') {
            let q = supabase.from("qrPointToken").select("*").eq("is_used", true).order("used_at", { ascending: false }).limit(limit);
            if (targetUser) q = q.eq("used_by", targetUser);
            const { data } = await q;
            (data || []).forEach(i => results.push({ machine_id: i.machine_id, line_user_id: i.used_by, amount: i.point_get, time: formatTime(i.used_at), raw_time: i.used_at, type: 'earn' }));
        }

        // 3. ดึงข้อมูล Redeem (จาก redeemlogs join กับ ninetyMember)
        if (type === 'redeem' || type === 'all') {
            let q = supabase.from("redeemlogs").select("*, ninetyMember(line_user_id)").order("created_at", { ascending: false }).limit(limit);
            const { data } = await q;
            let mapped = (data || []).map(i => ({ 
                machine_id: i.machine_id, 
                line_user_id: i.ninetyMember?.line_user_id || 'Unknown', 
                amount: i.points_redeemed, 
                time: formatTime(i.created_at), 
                raw_time: i.created_at, 
                type: 'redeem' 
            }));
            if (targetUser) mapped = mapped.filter(i => i.line_user_id === targetUser);
            results.push(...mapped);
        }

        // เรียงลำดับเวลาใหม่ทั้งหมด (ล่าสุดขึ้นก่อน) และตัดเอาตาม limit
        results.sort((a, b) => new Date(b.raw_time) - new Date(a.raw_time));
        res.json(results.slice(0, limit));
        
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API สร้าง QR (คงเดิม)
app.post("/create-qr", async (req, res) => {
    try {
        const { amount, machine_id } = req.body;
        const { data: config } = await supabase.from("system_configs").select("*").eq("config_key", "exchange_ratio").maybeSingle();
        const baht_rate = config ? config.baht_val : 10;
        const point_rate = config ? config.point_val : 1;
        const point_get = Math.floor((amount / baht_rate) * point_rate); 
        const token = crypto.randomUUID();
        await supabase.from("qrPointToken").insert({ qr_token: token, point_get, machine_id, scan_amount: amount, is_used: false, create_at: new Date().toISOString() });
        const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}?token=${token}`;
        res.json({ success: true, qr_url: liffUrl, points: point_get, token: token });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// API ดึงยอดแต้ม (คงเดิม)
app.get("/api/get-user-points", async (req, res) => {
    const { userId } = req.query;
    try {
        const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
        if (!m) return res.json({ points: 0 });
        const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).maybeSingle();
        res.json({ points: w?.point_balance || 0 });
    } catch (e) { res.status(500).json({ points: 0 }); }
});

// API สะสมแต้ม (คงเดิม)
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    const { data: qrData } = await supabase.from("qrPointToken").select("*").eq("qr_token", token).maybeSingle();
    if (!qrData || qrData.is_used) return res.status(400).send("QR Invalid");
    await supabase.from("qrPointToken").update({ is_used: true, used_by: userId, used_at: new Date().toISOString() }).eq("qr_token", token);
    let { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
    if (!member) { member = (await supabase.from("ninetyMember").insert({ line_user_id: userId }).select().single()).data; }
    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).maybeSingle();
    const newTotal = (wallet?.point_balance || 0) + qrData.point_get;
    await supabase.from("memberWallet").upsert({ member_id: member.id, point_balance: newTotal }, { onConflict: 'member_id' });
    await sendReplyPush(userId, `✨ สะสมสำเร็จ! +${qrData.point_get} แต้ม (รวม: ${newTotal})`);
    res.send("SUCCESS");
  } catch (err) { res.status(500).send(err.message); }
});

// API แลกแต้ม (คงเดิม)
app.get("/liff/redeem-execute", async (req, res) => {
  try {
    let { userId, amount, machine_id } = req.query;
    if (machine_id?.includes("machine_id=")) machine_id = machine_id.split("machine_id=")[1].split("&")[0];
    const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).maybeSingle();
    if (!w || w.point_balance < amount) return res.status(400).send("แต้มไม่พอ");
    const newBalance = w.point_balance - amount;
    await supabase.from("memberWallet").update({ point_balance: newBalance }).eq("member_id", m.id);
    await supabase.from("redeemlogs").insert({ member_id: m.id, machine_id, points_redeemed: parseInt(amount), status: "pending", created_at: new Date().toISOString() });
    await sendReplyPush(userId, `✅ แลกสำเร็จ! -${amount} แต้ม (เหลือ: ${newBalance})`);
    res.send(`SUCCESS: MACHINE_${machine_id}_START`);
  } catch (err) { res.status(500).send(err.message); }
});

/* ============================================================
   2. WEBHOOK & BOT LOGIC (เหมือนเดิม)
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
      if (isUserAdmin) {
        if (ratioWaitList.has(userId)) { ratioWaitList.delete(userId); return await updateExchangeRatio(rawMsg, event.replyToken); }
        if (adminWaitList.has(userId)) { adminWaitList.delete(userId); return await addNewAdmin(rawMsg, event.replyToken); }
        if (userMsg === "ADMIN") return await sendAdminDashboard(event.replyToken);
        if (userMsg === "MANAGE_ADMIN") return await sendManageAdminFlex(event.replyToken);
        if (userMsg === "REPORT") return await listCombinedReport(event.replyToken);
        if (userMsg === "LIST_ADMIN") return await listAdminsWithDelete(event.replyToken);
        if (userMsg === "SET_RATIO_STEP1") { ratioWaitList.add(userId); return await sendReply(event.replyToken, "📊 ระบุ บาท:แต้ม (เช่น 10:1)"); }
        if (userMsg === "ADD_ADMIN_STEP1") { adminWaitList.add(userId); return await sendReply(event.replyToken, "🆔 ส่ง ID เว้นวรรคตามด้วยชื่อ"); }
        if (userMsg.startsWith("DEL_ADMIN_ID ")) return await deleteAdmin(rawMsg.split(" ")[1], event.replyToken);
        if (userMsg.startsWith("APPROVE_ID ")) return await approveSpecificPoint(rawMsg.split(" ")[1], event.replyToken);
      }
      
      const pointMatch = rawMsg.match(/^(\d+)\s*(แต้ม|p|point)?$/i);
      if (pointMatch) {
          const points = parseInt(pointMatch[1]);
          await supabase.from("point_requests").insert({ line_user_id: userId, points, request_at: new Date().toISOString() });
          return await sendReply(event.replyToken, `📝 รับทราบค่ะ! ส่งคำขอ ${points} แต้ม ให้แอดมินแล้ว`);
      }
      if (userMsg === "CHECK_POINT") {
          const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
          if (m) {
             const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).maybeSingle();
             await sendReply(event.replyToken, `🌟 ยอดแต้มของคุณ: ${w?.point_balance || 0} แต้ม`);
          }
      }
    } catch (e) { console.error(e); }
  }
  res.sendStatus(200);
});

/* ============================================================
   3. HELPERS & DB LOGIC (คงเดิม)
============================================================ */
async function isAdmin(uid) { const { data } = await supabase.from("bot_admins").select("line_user_id").eq("line_user_id", uid).maybeSingle(); return !!data; }
async function updateExchangeRatio(input, rt) {
    const parts = input.split(":");
    if (parts.length !== 2) return await sendReply(rt, "❌ รูปแบบผิด! (ตัวอย่าง 10:1)");
    await supabase.from("system_configs").upsert({ config_key: "exchange_ratio", baht_val: parseInt(parts[0]), point_val: parseInt(parts[1]), updated_at: new Date().toISOString() }, { onConflict: 'config_key' });
    await sendReply(rt, `✅ ตั้งค่าสำเร็จ! ${parts[0]} บาท ต่อ ${parts[1]} แต้ม`);
}
async function addNewAdmin(input, rt) {
    const parts = input.split(/\s+/);
    await supabase.from("bot_admins").upsert({ line_user_id: parts[0], admin_name: parts.slice(1).join(" ") || "Admin" }, { onConflict: 'line_user_id' });
    await sendReply(rt, `✅ เพิ่มแอดมินสำเร็จ`);
}
async function deleteAdmin(tid, rt) {
    await supabase.from("bot_admins").delete().eq("line_user_id", tid);
    await sendReply(rt, "🗑️ ลบเรียบร้อย");
}
async function approveSpecificPoint(rid, rt) {
    const { data: req } = await supabase.from("point_requests").select("*").eq("id", rid).maybeSingle();
    if (!req) return await sendReply(rt, "❌ ไม่พบรายการ");
    let { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", req.line_user_id).maybeSingle();
    if (!m) { m = (await supabase.from("ninetyMember").insert({ line_user_id: req.line_user_id }).select().single()).data; }
    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).maybeSingle();
    const newTotal = (w?.point_balance || 0) + req.points;
    await supabase.from("memberWallet").upsert({ member_id: m.id, point_balance: newTotal }, { onConflict: 'member_id' });
    await supabase.from("point_requests").delete().eq("id", req.id);
    await sendReply(rt, `✅ อนุมัติสำเร็จ!`);
    await sendReplyPush(req.line_user_id, `🎊 เติมแต้มให้ ${req.points} แต้มแล้วค่ะ`);
}

/* ============================================================
   4. UI DASHBOARD & REPORT (อัปเกรดให้คลิก Header ได้)
============================================================ */

async function sendAdminDashboard(replyToken) {
  const flex = { 
      type: "bubble", 
      header: { type: "box", layout: "vertical", backgroundColor: "#1c1c1c", contents: [{ type: "text", text: "NINETY God Mode", color: "#00b900", weight: "bold", size: "xl" }] }, 
      body: { type: "box", layout: "vertical", spacing: "md", contents: [
          { type: "button", style: "primary", color: "#333333", action: { type: "message", label: "⚙️ MANAGE ADMIN", text: "MANAGE_ADMIN" } }, 
          { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📊 ACTIVITY REPORT", text: "REPORT" } },
          { type: "button", style: "primary", color: "#ff9f00", action: { type: "message", label: "💰 SET EXCHANGE RATIO", text: "SET_RATIO_STEP1" } }
      ]} 
  };
  await sendFlex(replyToken, "God Mode", flex);
}

async function listCombinedReport(replyToken) {
  try {
    const { data: pending } = await supabase.from("point_requests").select("*").limit(3).order("request_at", { ascending: false });
    const { data: earns } = await supabase.from("qrPointToken").select("*").eq("is_used", true).order("used_at", { ascending: false }).limit(5);
    const { data: redeems } = await supabase.from("redeemlogs").select("*, ninetyMember(line_user_id)").limit(5).order("created_at", { ascending: false });
    
    const formatTime = (iso) => iso ? new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : "--:--";
    const liffReportUrl = `https://liff.line.me/${process.env.LIFF_ID}?view=report`;

    const flex = {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md", contents: [
        { type: "text", text: "📊 ACTIVITY REPORT", weight: "bold", color: "#00b900", size: "lg" },
        
        // --- Header Pending (Clickable) ---
        { type: "text", text: "🔔 PENDING (กดดู 20 รายการ)", weight: "bold", size: "xs", color: "#ff4b4b", action: { type: "uri", label: "view", uri: liffReportUrl } },
        { type: "box", layout: "vertical", contents: (pending?.length > 0) ? pending.map(r => ({ type: "box", layout: "horizontal", margin: "xs", contents: [{ type: "text", text: `+${r.points}p [${r.line_user_id.substring(0, 6)}..]`, size: "xxs", gravity: "center", flex: 3 }, { type: "button", style: "primary", color: "#00b900", height: "sm", flex: 2, action: { type: "message", label: "OK", text: `APPROVE_ID ${r.id}` } }] })) : [{ type: "text", text: "-", size: "xxs" }] },
        
        { type: "separator" },

        // --- Header Earns (Clickable) ---
        { type: "text", text: "📥 RECENT EARNS (กดดู 20 รายการ)", weight: "bold", size: "xs", color: "#00b900", action: { type: "uri", label: "view", uri: liffReportUrl } },
        { type: "box", layout: "vertical", spacing: "xs", contents: (earns?.length > 0) ? earns.map(e => ({ type: "text", text: `• [${e.machine_id || '??'}] | ${e.used_by?.substring(0,6)} | +${e.point_get}p | ${formatTime(e.used_at)}`, size: "xxs" })) : [{ type: "text", text: "-", size: "xxs" }] },
        
        { type: "separator" },

        // --- Header Redeems (Clickable) ---
        { type: "text", text: "📤 RECENT REDEEMS (กดดู 20 รายการ)", weight: "bold", size: "xs", color: "#ff9f00", action: { type: "uri", label: "view", uri: liffReportUrl } },
        { type: "box", layout: "vertical", spacing: "xs", contents: (redeems?.length > 0) ? redeems.map(u => ({ type: "text", text: `• [${u.machine_id || '??'}] | ${u.ninetyMember?.line_user_id?.substring(0,6) || '?'} | -${u.points_redeemed}p | ${formatTime(u.created_at)}`, size: "xxs" })) : [{ type: "text", text: "-", size: "xxs" }] }
      ]}
    };
    await sendFlex(replyToken, "Activity Report", flex);
  } catch (e) { console.error(e); }
}

/* ============================================================
   5. MESSAGE SENDER (คงเดิม)
============================================================ */
async function sendReply(rt, text) { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }
async function sendReplyPush(to, text) { await axios.post("https://api.line.me/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }
async function sendFlex(rt, altText, contents) { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "flex", altText, contents }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 God Mode on port ${PORT}`));
