require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const PDFDocument = require('pdfkit'); 
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

// ตัวแปรคุมสถานะรอรับ ID สำหรับการเพิ่ม Admin
let adminWaitList = new Set(); 

/* ====================================
   1. WEBHOOK (ADMIN DASHBOARD v2.3 - Safety Version)
==================================== */
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  for (let event of events) {
    const userId = event.source.userId;
    const isUserAdmin = await isAdmin(userId);

    if (event.type === "message" && event.message.type === "text") {
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
            else if (userMsg === "MANAGE_ADMIN") return await sendManageAdminFlex(event.replyToken);
            else if (userMsg === "REPORT") return await listCombinedReport(event.replyToken);
            else if (userMsg === "LIST_ADMIN") return await listAdminsWithDelete(event.replyToken);
            else if (userMsg === "ADD_ADMIN_STEP1") {
                adminWaitList.add(userId);
                return await sendReply(event.replyToken, "🆔 ส่ง User ID ที่ต้องการเพิ่มมาได้เลยค่ะ");
            }
            else if (userMsg.startsWith("DEL_ADMIN_ID ")) return await deleteAdmin(rawMsg.split(" ")[1], event.replyToken);
            else if (userMsg.startsWith("APPROVE_ID ")) return await approveSpecificPoint(rawMsg.split(" ")[1], event.replyToken);
            else if (userMsg.startsWith("USAGE ")) return await getCustomerReport(rawMsg.split(" ")[1], event.replyToken, userId);
        }

        const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
        if (member) {
            if (userMsg === "CHECK_POINT") {
                const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
                await sendReply(event.replyToken, `🌟 ยอดปัจจุบัน: ${w?.point_balance || 0} แต้ม`);
            } else if (userMsg === "REFUND") await handleRefund(member.id, event.replyToken);
        }
      } catch (e) { console.error(e.message); }
    }
  }
  res.sendStatus(200);
});

/* ====================================
   2. UI COMPONENTS (With Safety Logic)
==================================== */

async function listAdminsWithDelete(replyToken) {
    const { data: adms } = await supabase.from("bot_admins").select("*");
    if (!adms) return await sendReply(replyToken, "❌ ไม่พบข้อมูลแอดมิน");

    const isAdminOnlyOne = adms.length <= 1; // เช็กว่าเป็นคนสุดท้ายไหม

    const rows = adms.map(a => {
        const rowContents = [
            { type: "text", text: `👤 ${a.admin_name || 'Admin'}`, size: "xs", gravity: "center", flex: 3 }
        ];

        // 🛡️ ถ้าไม่ใช่คนสุดท้าย ถึงจะโชว์ปุ่มลบ
        if (!isAdminOnlyOne) {
            rowContents.push({ 
                type: "button", style: "primary", color: "#ff4b4b", height: "sm", flex: 2, 
                action: { type: "message", label: "🗑️ REMOVE", text: `DEL_ADMIN_ID ${a.line_user_id}` } 
            });
        } else {
            rowContents.push({ type: "text", text: "👑 (Last Admin)", size: "xxs", color: "#aaaaaa", gravity: "center", flex: 2, align: "end" });
        }

        return { type: "box", layout: "horizontal", margin: "sm", contents: rowContents };
    });

    const flex = {
        type: "flex", altText: "Admin List",
        contents: { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "🔐 ADMIN LIST", weight: "bold" }, ...rows] } }
    };
    await sendFlex(replyToken, flex);
}

// ฟังก์ชันลบแอดมิน (เพิ่มด่านตรวจสุดท้าย)
async function deleteAdmin(targetId, replyToken) {
    try {
        const { data: adms } = await supabase.from("bot_admins").select("line_user_id");
        if (adms.length <= 1) {
            return await sendReply(replyToken, "⚠️ ไม่สามารถลบได้! ระบบต้องมีแอดมินอย่างน้อย 1 คนค่ะ");
        }
        await supabase.from("bot_admins").delete().eq("line_user_id", targetId);
        await sendReply(replyToken, "🗑️ ลบแอดมินเรียบร้อยแล้วค่ะ");
    } catch (e) { await sendReply(replyToken, "❌ ลบไม่ได้: " + e.message); }
}

/* ====================================
   3. OTHER FUNCTIONS (คงเดิม)
==================================== */
async function sendAdminDashboard(replyToken) {
    const flex = { type: "flex", altText: "Dashboard", contents: { type: "bubble", header: { type: "box", layout: "vertical", backgroundColor: "#1c1c1c", contents: [{ type: "text", text: "NINETY God Mode", color: "#00b900", weight: "bold", size: "xl" }] }, body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "button", style: "primary", color: "#333333", action: { type: "message", label: "⚙️ MANAGE ADMIN", text: "MANAGE_ADMIN" } }, { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📊 ACTIVITY REPORT", text: "REPORT" } }] } } };
    await sendFlex(replyToken, flex);
}
async function sendManageAdminFlex(replyToken) {
    const flex = { type: "flex", altText: "Manage Admin", contents: { type: "bubble", body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "⚙️ ADMIN SETTINGS", weight: "bold", size: "lg" }, { type: "button", style: "secondary", action: { type: "message", label: "📋 LIST & REMOVE ADMIN", text: "LIST_ADMIN" } }, { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "➕ ADD NEW ADMIN", text: "ADD_ADMIN_STEP1" } }] } } };
    await sendFlex(replyToken, flex);
}
async function listCombinedReport(replyToken) {
    const { data: pending } = await supabase.from("point_requests").select("*").limit(3).order("request_at", { ascending: false });
    const { data: earns } = await supabase.from("qrPointToken").select("*").limit(5).order("used_at", { ascending: false });
    const { data: redeems } = await supabase.from("redeemlogs").select("*").limit(5).order("created_at", { ascending: false });
    const flex = { type: "flex", altText: "Activity Report", contents: { type: "bubble", body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "📊 ACTIVITY REPORT", weight: "bold", color: "#00b900", size: "lg" }, { type: "text", text: "🔔 PENDING REQUESTS", weight: "bold", size: "xs", color: "#ff4b4b" }, { type: "box", layout: "vertical", contents: (pending && pending.length > 0) ? pending.map(r => ({ type: "box", layout: "horizontal", margin: "xs", contents: [{ type: "text", text: `+${r.points} (${r.line_user_id.substring(0,5)})`, size: "xxs", gravity: "center" }, { type: "button", style: "primary", color: "#00b900", height: "sm", flex: 0, action: { type: "message", label: "OK", text: `APPROVE_ID ${r.id}` } }] })) : [{ type: "text", text: "ไม่พบรายการค้าง", size: "xxs", color: "#aaaaaa" }] }, { type: "separator" }, { type: "text", text: "📥 RECENT EARNS (5)", weight: "bold", size: "xs", color: "#00b900" }, ...earns.map(e => ({ type: "text", text: `• ${new Date(e.used_at).toLocaleTimeString('th-TH')} | +${e.point_get} pts`, size: "xxs" })), { type: "separator" }, { type: "text", text: "📤 RECENT REDEEMS (5)", weight: "bold", size: "xs", color: "#ff9f00" }, ...redeems.map(u => ({ type: "text", text: `• ${new Date(u.created_at).toLocaleTimeString('th-TH')} | -${u.points_redeemed} pts`, size: "xxs" }))] } } };
    await sendFlex(replyToken, flex);
}
async function isAdmin(uid) { const { data } = await supabase.from("bot_admins").select("line_user_id").eq("line_user_id", uid).single(); return !!data; }
async function addNewAdmin(targetId, replyToken) { if (!targetId.startsWith("U") || targetId.length < 30) return await sendReply(replyToken, "❌ รหัส ID ผิดพลาด"); await supabase.from("bot_admins").insert({ line_user_id: targetId, admin_name: "Admin_New" }); await sendReply(replyToken, `✅ เพิ่มแอดมิน ${targetId.substring(0,6)}... สำเร็จ!`); }
async function approveSpecificPoint(requestId, replyToken) {
    const { data: req } = await supabase.from("point_requests").select("*").eq("id", requestId).single();
    if (!req) return;
    const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", req.line_user_id).single();
    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
    const newTotal = (w?.point_balance || 0) + req.points;
    await supabase.from("memberWallet").upsert({ member_id: m.id, point_balance: newTotal }, { onConflict: 'member_id' });
    await supabase.from("point_requests").delete().eq("id", req.id);
    await sendReply(replyToken, `✅ อนุมัติสำเร็จ!`);
    await sendReplyPush(req.line_user_id, `🎊 แอดมินเติมให้ ${req.points} แต้มแล้วค่ะ`);
}
async function getCustomerReport(targetUid, replyToken, adminId) {
    const { data: earns } = await supabase.from("qrPointToken").select("*").eq("used_by", targetUid).limit(5).order("used_at", { ascending: false });
    const flex = { type: "flex", altText: "Report", contents: { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "📊 ประวัติการใช้งาน", weight: "bold", size: "lg" }, ...earns.map(e => ({ type: "text", text: `${new Date(e.used_at).toLocaleDateString()} | +${e.point_get} pts`, size: "xs" }))] }, footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#00b900", action: { type: "uri", label: "ดาวน์โหลด PDF", uri: `https://${process.env.RAILWAY_STATIC_URL}/api/report-pdf?userId=${targetUid}&adminId=${adminId}` } }] } } };
    await sendFlex(replyToken, flex);
}
async function handleRefund(memberId, replyToken) {
  const { data: log } = await supabase.from("redeemlogs").select("*").eq("member_id", memberId).eq("status", 'pending').order("created_at", { ascending: false }).limit(1).single();
  if (!log) return await sendReply(replyToken, "❌ ไม่พบรายการคืนแต้ม");
  const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", memberId).single();
  const newTotal = (wallet?.point_balance || 0) + log.points_redeemed;
  await supabase.from("memberWallet").update({ point_balance: newTotal }).eq("member_id", memberId);
  await supabase.from("redeemlogs").update({ status: 'refunded' }).eq("id", log.id);
  await sendReply(replyToken, `💰 คืนแต้มสำเร็จ!`);
}
async function sendReply(replyToken, text) { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }
async function sendReplyPush(to, text) { await axios.post("https://api.line.me/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }
async function sendFlex(replyToken, flex) { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken, messages: [flex] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); }

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 God Mode Server on port ${PORT}`));
