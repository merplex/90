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
   1. WEBHOOK & ADMIN SYSTEM
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
      }
      // ส่วนลูกค้า
      const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
      if (member && userMsg === "CHECK_POINT") {
          const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
          await sendReply(event.replyToken, `🌟 ยอดปัจจุบัน: ${w?.point_balance || 0} แต้ม`);
      }
    } catch (e) { console.error(e.message); }
  }
  res.sendStatus(200);
});

/* ====================================
   2. UI COMPONENTS (Fixed Table Fields)
==================================== */

// แก้ไข LIST ADMIN ให้ดึงค่าได้ถูกต้อง
async function listAdminsWithDelete(replyToken) {
  try {
    const { data: adms, error } = await supabase.from("bot_admins").select("*");
    if (error || !adms) return await sendReply(replyToken, "❌ ไม่พบข้อมูลแอดmิน");

    const isOnlyOne = adms.length <= 1;
    const adminRows = adms.map(a => ({
      type: "box", layout: "horizontal", margin: "sm", contents: [
        { type: "text", text: `👤 ${a.admin_name || 'Admin'}`, size: "xs", gravity: "center", flex: 3 },
        !isOnlyOne ? { type: "button", style: "primary", color: "#ff4b4b", height: "sm", flex: 2, action: { type: "message", label: "🗑️ REMOVE", text: `DEL_ADMIN_ID ${a.line_user_id}` } } 
        : { type: "text", text: "👑 (Last)", size: "xxs", color: "#aaaaaa", gravity: "center", align: "end", flex: 2 }
      ]
    }));
    await sendFlex(replyToken, { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "🔐 ADMIN LIST", weight: "bold" }, ...adminRows] } });
  } catch (e) { await sendReply(replyToken, "❌ รายชื่อผิดพลาด: " + e.message); }
}

// แก้ไข REPORT ให้ใช้ used_by แทน member_id สำหรับ qrPointToken
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
        // ✨ ใช้ e.used_by ตามตารางจริงของเปรม
        { type: "text", text: "📥 RECENT EARNS (รับแต้ม)", weight: "bold", size: "xs", color: "#00b900" },
        { type: "box", layout: "vertical", spacing: "xs", contents: (earns?.length > 0) ? earns.map(e => ({
          type: "text", text: `• [${e.machine_id || '??'}] | ${e.used_by?.substring(0,5) || 'Guest'} | +${e.point_get} pts | ${formatTime(e.used_at)}`, size: "xxs"
        })) : [{ type: "text", text: "ไม่มีประวัติ", size: "xxs" }] },
        { type: "separator" },
        { type: "text", text: "📤 RECENT REDEEMS (แลกแต้ม)", weight: "bold", size: "xs", color: "#ff9f00" },
        { type: "box", layout: "vertical", spacing: "xs", contents: (redeems?.length > 0) ? redeems.map(u => ({
          type: "text", text: `• [${u.machine_id || '??'}] | ${u.member_id?.toString().substring(0,5) || '??'} | -${u.points_redeemed} pts | ${formatTime(u.created_at)}`, size: "xxs"
        })) : [{ type: "text", text: "ไม่มีประวัติ", size: "xxs" }] }
      ]}
    };
    await sendFlex(replyToken, flex);
  } catch (e) { await sendReply(replyToken, "❌ ดึงรายงานไม่สำเร็จ: " + e.message); }
}

/* ====================================
   3. HELPERS
==================================== */
async function isAdmin(uid) { const { data } = await supabase.from("bot_admins").select("line_user_id").eq("line_user_id", uid).single(); return !!data; }

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

async function sendReply(rt, text) { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }
async function sendFlex(rt, contents) { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "flex", altText: "Admin God Mode", contents }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 God Mode on port ${PORT}`));
