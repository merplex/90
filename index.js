require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const PDFDocument = require('pdfkit'); 
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors(), express.json(), express.static("public"));

const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");
let adminWaitList = new Set(); 

/* ====================================
   1. POINT & REDEEM SYSTEM
==================================== */
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    const { data: qrData } = await supabase.from("qrPointToken").select("*").eq("qr_token", token).single();
    if (!qrData || qrData.is_used) return res.status(400).send("QR Invalid");
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
   2. WEBHOOK (ADMIN COMMANDS)
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
        if (userMsg === "ADMIN") return await sendAdminDashboard(event.replyToken);
        if (userMsg === "MANAGE_ADMIN") return await sendManageAdminFlex(event.replyToken);
        if (userMsg === "REPORT") return await listCombinedReport(event.replyToken);
        if (userMsg === "LIST_ADMIN") return await listAdminsWithDelete(event.replyToken);
        if (userMsg === "ADD_ADMIN_STEP1") { adminWaitList.add(userId); return await sendReply(event.replyToken, "🆔 ส่ง ID เว้นวรรคตามด้วยชื่อมาได้เลยค่ะ"); }
        if (userMsg.startsWith("DEL_ADMIN_ID ")) return await deleteAdmin(rawMsg.split(" ")[1], event.replyToken);
        if (userMsg.startsWith("APPROVE_ID ")) return await approveSpecificPoint(rawMsg.split(" ")[1], event.replyToken);
        if (userMsg.startsWith("USAGE ")) return await getCustomerReport(rawMsg.split(" ")[1], event.replyToken, userId);
      }
      const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
      if (member) {
        if (userMsg === "CHECK_POINT") {
          const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
          await sendReply(event.replyToken, `🌟 คุณมี: ${w?.point_balance || 0} แต้ม`);
        } else if (userMsg === "REFUND") await handleRefund(member.id, event.replyToken);
      }
    } catch (e) { console.error(e.message); }
  }
  res.sendStatus(200);
});

/* ====================================
   3. UI COMPONENTS (FIXED & IMPROVED)
==================================== */
async function sendAdminDashboard(replyToken) {
  const flex = { type: "bubble", header: { type: "box", layout: "vertical", backgroundColor: "#1c1c1c", contents: [{ type: "text", text: "NINETY God Mode", color: "#00b900", weight: "bold", size: "xl" }] }, body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "button", style: "primary", color: "#333333", action: { type: "message", label: "⚙️ MANAGE ADMIN", text: "MANAGE_ADMIN" } }, { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📊 ACTIVITY REPORT", text: "REPORT" } }] } };
  await sendFlex(replyToken, flex);
}

async function sendManageAdminFlex(replyToken) {
  const flex = { type: "bubble", body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "⚙️ ADMIN SETTINGS", weight: "bold", size: "lg" }, { type: "button", style: "secondary", action: { type: "message", label: "📋 LIST & REMOVE ADMIN", text: "LIST_ADMIN" } }, { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "➕ ADD NEW ADMIN", text: "ADD_ADMIN_STEP1" } }] } };
  await sendFlex(replyToken, flex);
}

async function listAdminsWithDelete(replyToken) {
  const { data: adms } = await supabase.from("bot_admins").select("*");
  const isOnlyOne = adms.length <= 1;
  const adminRows = adms.map(a => ({
    type: "box", layout: "horizontal", margin: "sm", contents: [
      { type: "text", text: `👤 ${a.admin_name || 'Admin'}`, size: "xs", gravity: "center", flex: 3 },
      !isOnlyOne ? { type: "button", style: "primary", color: "#ff4b4b", height: "sm", flex: 2, action: { type: "message", label: "🗑️ REMOVE", text: `DEL_ADMIN_ID ${a.line_user_id}` } } : { type: "text", text: "👑 (Last)", size: "xxs", color: "#aaaaaa", gravity: "center", align: "end", flex: 2 }
    ]
  }));
  await sendFlex(replyToken, { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "🔐 ADMIN LIST", weight: "bold" }, ...adminRows] } });
}

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
        { type: "text", text: "🔔 PENDING (งานค้าง)", weight: "bold", size: "xs", color: "#ff4b4b" },
        { type: "box", layout: "vertical", contents: (pending?.length > 0) ? pending.map(r => ({
          type: "box", layout: "horizontal", margin: "xs", contents: [
            { type: "text", text: `+${r.points} pts [..${r.line_user_id.slice(-5)}]`, size: "xxs", gravity: "center", flex: 3 },
            { type: "button", style: "primary", color: "#00b900", height: "sm", flex: 2, action: { type: "message", label: "OK", text: `APPROVE_ID ${r.id}` } }
          ]
        })) : [{ type: "text", text: "ไม่พบรายการค้าง", size: "xxs", color: "#aaaaaa" }] },
        { type: "separator" },
        { type: "text", text: "📥 RECENT EARNS (รับแต้ม)", weight: "bold", size: "xs", color: "#00b900" },
        { type: "box", layout: "vertical", spacing: "xs", contents: (earns?.length > 0) ? earns.map(e => ({
          type: "text", text: `• [${e.machine_id || '??'}] | ${e.used_by?.substring(0,5)} | +${e.point_get} pts | ${formatTime(e.used_at || e.create_at)}`, size: "xxs"
        })) : [{ type: "text", text: "ไม่มีประวัติ", size: "xxs" }] },
        { type: "separator" },
        { type: "text", text: "📤 RECENT REDEEMS (แลกแต้ม)", weight: "bold", size: "xs", color: "#ff9f00" },
        { type: "box", layout: "vertical", spacing: "xs", contents: (redeems?.length > 0) ? redeems.map(u => ({
          type: "text", text: `• [${u.machine_id || '??'}] | ${u.member_id?.toString().substring(0,5)} | -${u.points_redeemed} pts | ${formatTime(u.created_at)}`, size: "xxs"
        })) : [{ type: "text", text: "ไม่มีประวัติ", size: "xxs" }] }
      ]}
    };
    await sendFlex(replyToken, flex);
  } catch (e) { await sendReply(replyToken, "❌ Error: " + e.message); }
}

/* ====================================
   4. LOGIC HELPERS
==================================== */
async function isAdmin(uid) { return !!(await supabase.from("bot_admins").select("line_user_id").eq("line_user_id", uid).single()).data; }

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
  if (adms.length <= 1) return await sendReply(rt, "⚠️ ลบไม่ได้! ต้องมีอย่างน้อย 1 คน");
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
  await sendReplyPush(req.line_user_id, `🎊 แอดมินอนุมัติให้ ${req.points} แต้มแล้วค่ะ`);
}

async function getCustomerReport(targetUid, rt, adminId) {
  const { data: earns } = await supabase.from("qrPointToken").select("*").eq("used_by", targetUid).limit(5).order("used_at", { ascending: false });
  const flex = { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "📊 ประวัติการใช้งาน", weight: "bold", size: "lg" }, ...earns.map(e => ({ type: "text", text: `${new Date(e.used_at || e.create_at).toLocaleDateString()} | +${e.point_get} pts`, size: "xs" }))] }, footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#00b900", action: { type: "uri", label: "ดาวน์โหลด PDF", uri: `https://${process.env.RAILWAY_STATIC_URL}/api/report-pdf?userId=${targetUid}&adminId=${adminId}` } }] } };
  await sendFlex(rt, flex);
}

async function handleRefund(memberId, rt) {
  const { data: log } = await supabase.from("redeemlogs").select("*").eq("member_id", memberId).eq("status", 'pending').order("created_at", { ascending: false }).limit(1).single();
  if (!log) return await sendReply(rt, "❌ ไม่พบรายการคืนแต้ม");
  const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", memberId).single();
  const newTotal = (wallet?.point_balance || 0) + log.points_redeemed;
  await supabase.from("memberWallet").update({ point_balance: newTotal }).eq("member_id", memberId);
  await supabase.from("redeemlogs").update({ status: 'refunded' }).eq("id", log.id);
  await sendReply(rt, `💰 คืนแต้มสำเร็จ!`);
}

async function sendReply(rt, text) { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }
async function sendReplyPush(to, text) { await axios.post("https://api.line.me/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }
async function sendFlex(rt, flexContents) { 
  await axios.post("https://api.line.me/v2/bot/message/reply", { 
    replyToken: rt, 
    messages: [{ type: "flex", altText: "God Mode Interface", contents: flexContents }] 
  }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); 
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 God Mode on port ${PORT}`));
