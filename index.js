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

/* ====================================
   1. POINT SYSTEM & REDEEM API (คงเดิม)
==================================== */
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    const { data: qrData } = await supabase.from("qrPointToken").select("*").eq("qr_token", token).single();
    if (!qrData || qrData.is_used) return res.status(400).send("QR ใช้ไม่ได้แล้วค่ะ");
    await supabase.from("qrPointToken").update({ is_used: true, used_by: userId, used_at: new Date().toISOString() }).eq("qr_token", token);
    let { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
    if (!member) {
      const { data: newM } = await supabase.from("ninetyMember").insert({ line_user_id: userId }).select().single();
      member = newM;
    }
    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
    const newTotal = (wallet?.point_balance || 0) + qrData.point_get;
    await supabase.from("memberWallet").upsert({ member_id: member.id, point_balance: newTotal }, { onConflict: 'member_id' });
    await sendReplyPush(userId, `สะสมสำเร็จ! +${qrData.point_get} แต้ม (รวม: ${newTotal})`);
    res.send("SUCCESS");
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/liff/redeem-execute", async (req, res) => {
  try {
    let { userId, amount, machine_id } = req.query;
    if (machine_id && machine_id.includes("machine_id=")) {
        machine_id = machine_id.split("machine_id=")[1].split("&")[0];
    }
    const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
    if (w.point_balance < amount) return res.status(400).send("แต้มไม่พอ");
    const newBalance = w.point_balance - amount;
    await supabase.from("memberWallet").update({ point_balance: newBalance }).eq("member_id", m.id);
    await supabase.from("redeemlogs").insert({ member_id: m.id, machine_id, points_redeemed: parseInt(amount), status: "pending" });
    await sendReplyPush(userId, `✅ ใช้แต้มสำเร็จ!\nหัก: ${amount} แต้ม\nเครื่อง: ${machine_id}\nคงเหลือ: ${newBalance} แต้ม`);
    res.send(`SUCCESS: MACHINE_${machine_id}_START`);
  } catch (err) { res.status(500).send(err.message); }
});

/* ====================================
   2. WEBHOOK (GOD MODE DASHBOARD)
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
            // --- ⚙️ คำสั่งหลัก ADMIN ---
            if (userMsg === "ADMIN") {
                return await sendAdminDashboard(event.replyToken);
            }
            else if (userMsg === "MANAGE_ADMIN") {
                return await sendManageAdminFlex(event.replyToken);
            }
            else if (userMsg === "REPORT") {
                return await listRecentUsersForReport(event.replyToken);
            }
            else if (userMsg === "REQUEST") {
                return await listPendingRequests(event.replyToken);
            }
            // --- ⚡ คำสั่ง Logic ---
            else if (userMsg.startsWith("USAGE ")) {
                return await getCustomerReport(rawMsg.split(" ")[1], event.replyToken, userId);
            }
            else if (userMsg.startsWith("APPROVE_ID ")) {
                return await approveSpecificPoint(rawMsg.split(" ")[1], event.replyToken);
            }
            else if (userMsg === "LIST_ADMIN") {
                const { data: adms } = await supabase.from("bot_admins").select("*");
                return await sendReply(event.replyToken, "🔐 รายชื่อแอดมิน:\n" + adms.map(a => `- ${a.admin_name}`).join('\n'));
            }
        }

        // --- 👤 ส่วนลูกค้า ---
        const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
        if (member) {
            if (userMsg === "CHECK_POINT") {
                const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
                await sendReply(event.replyToken, `🌟 ยอดแต้มปัจจุบัน: ${w?.point_balance || 0} แต้ม`);
            } else if (userMsg === "REFUND") {
                await handleRefund(member.id, event.replyToken);
            }
        }
      } catch (e) { console.error(e.message); }
    }
  }
  res.sendStatus(200);
});

/* ====================================
   3. PROFESSIONAL FLEX UI (DASHBOARD)
==================================== */

// หน้า Dashboard หลัก (ดูโปรสุดๆ)
async function sendAdminDashboard(replyToken) {
    const flex = {
        type: "flex", altText: "Admin God Mode Dashboard",
        contents: {
            type: "bubble",
            header: {
                type: "box", layout: "vertical", backgroundColor: "#1c1c1c", contents: [
                    { type: "text", text: "NINETY God Mode", color: "#00b900", weight: "bold", size: "xl" },
                    { type: "text", text: "Management System v2.0", color: "#aaaaaa", size: "xs" }
                ]
            },
            body: {
                type: "box", layout: "vertical", spacing: "lg", contents: [
                    { type: "button", style: "primary", color: "#333333", height: "md", action: { type: "message", label: "⚙️ MANAGE ADMIN", text: "MANAGE_ADMIN" } },
                    { type: "button", style: "primary", color: "#333333", height: "md", action: { type: "message", label: "📊 REPORT", text: "REPORT" } },
                    { type: "button", style: "primary", color: "#ff4b4b", height: "md", action: { type: "message", label: "🔔 REQUEST (PENDING)", text: "REQUEST" } }
                ]
            }
        }
    };
    await sendFlex(replyToken, flex);
}

// รายชื่อลูกค้าล่าสุด (สำหรับดู Report)
async function listRecentUsersForReport(replyToken) {
    const { data: recent } = await supabase.from("point_requests").select("line_user_id").limit(5).order("request_at", { ascending: false });
    if (!recent || recent.length === 0) return await sendReply(replyToken, "📭 ไม่พบประวัติลูกค้าล่าสุด");

    const buttons = recent.map(u => ({
        type: "box", layout: "horizontal", margin: "md", contents: [
            { type: "text", text: `👤 ID: ${u.line_user_id.substring(0, 8)}...`, gravity: "center", size: "sm" },
            { type: "button", style: "primary", color: "#00b900", height: "sm", flex: 0, action: { type: "message", label: "VIEW", text: `USAGE ${u.line_user_id}` } }
        ]
    }));

    const flex = {
        type: "flex", altText: "Customer Reports",
        contents: {
            type: "bubble",
            body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "📊 เลือก User เพื่อดูรายงาน", weight: "bold" }, ...buttons] }
        }
    };
    await sendFlex(replyToken, flex);
}

// รายการขอแต้ม (Request)
async function listPendingRequests(replyToken) {
    const { data: reqs } = await supabase.from("point_requests").select("*").limit(5).order("request_at", { ascending: true });
    if (!reqs || reqs.length === 0) return await sendReply(replyToken, "✅ ไม่มีคำขอค้างอยู่");

    const list = reqs.map(r => ({
        type: "box", layout: "horizontal", margin: "md", spacing: "sm", contents: [
            { type: "text", text: `+${r.points} pts | ${r.line_user_id.substring(0,5)}`, size: "xs", gravity: "center", flex: 3 },
            { type: "button", style: "primary", color: "#00b900", height: "sm", flex: 2, action: { type: "message", label: "OK", text: `APPROVE_ID ${r.id}` } }
        ]
    }));

    const flex = {
        type: "flex", altText: "Pending Points",
        contents: {
            type: "bubble",
            body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "🔔 รายการรออนุมัติ", weight: "bold", color: "#ff4b4b" }, ...list] }
        }
    };
    await sendFlex(replyToken, flex);
}

// หน้าจัดการ Admin ย่อย
async function sendManageAdminFlex(replyToken) {
    const flex = {
        type: "flex", altText: "Manage Admin",
        contents: {
            type: "bubble",
            body: {
                type: "box", layout: "vertical", spacing: "sm", contents: [
                    { type: "text", text: "⚙️ ADMIN SETTINGS", weight: "bold" },
                    { type: "button", style: "secondary", action: { type: "message", label: "📋 LIST ADMIN", text: "LIST_ADMIN" } },
                    { type: "button", style: "secondary", action: { type: "message", label: "➕ ADD ADMIN", text: "ADD ADMIN [ID]" } },
                    { type: "button", style: "secondary", action: { type: "message", label: "❌ DEL ADMIN", text: "DEL ADMIN [ID]" } }
                ]
            }
        }
    };
    await sendFlex(replyToken, flex);
}

/* ====================================
   4. HELPER FUNCTIONS (คงเดิมทั้งหมด)
==================================== */
async function isAdmin(uid) {
    const { data } = await supabase.from("bot_admins").select("line_user_id").eq("line_user_id", uid).single();
    return !!data;
}

async function approveSpecificPoint(requestId, replyToken) {
    const { data: reqRecord } = await supabase.from("point_requests").select("*").eq("id", requestId).single();
    if (!reqRecord) return await sendReply(replyToken, "❌ รายการนี้ถูกจัดการไปแล้ว");
    const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", reqRecord.line_user_id).single();
    if (m) {
        const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
        const newTotal = (w?.point_balance || 0) + reqRecord.points;
        await supabase.from("memberWallet").upsert({ member_id: m.id, point_balance: newTotal }, { onConflict: 'member_id' });
        await supabase.from("point_requests").delete().eq("id", reqRecord.id);
        await sendReply(replyToken, `✅ อนุมัติ ${reqRecord.points} แต้ม สำเร็จ!`);
        await sendReplyPush(reqRecord.line_user_id, `🎊 แอดมินเติมแต้มให้แล้ว ${reqRecord.points} แต้ม (รวม: ${newTotal})`);
    }
}

async function getCustomerReport(targetUid, replyToken, adminId) {
    const { data: earns } = await supabase.from("qrPointToken").select("*").eq("used_by", targetUid).limit(5).order("used_at", { ascending: false });
    const flex = {
        type: "flex", altText: "รายงานลูกค้า",
        contents: {
            type: "bubble",
            body: {
                type: "box", layout: "vertical", contents: [
                    { type: "text", text: "📊 ประวัติการใช้งาน", weight: "bold", size: "lg" },
                    ...earns.map(e => ({ type: "text", text: `${new Date(e.used_at).toLocaleDateString()} | +${e.point_get} pts`, size: "xs" }))
                ]
            },
            footer: {
                type: "box", layout: "vertical", contents: [{
                    type: "button", style: "primary", color: "#00b900",
                    action: { type: "uri", label: "ดาวน์โหลด PDF", uri: `https://${process.env.RAILWAY_STATIC_URL}/api/report-pdf?userId=${targetUid}&adminId=${adminId}` }
                }]
            }
        }
    };
    await sendFlex(replyToken, flex);
}

async function handleRefund(memberId, replyToken) {
  const { data: log } = await supabase.from("redeemlogs").select("*").eq("member_id", memberId).eq("status", 'pending').order("created_at", { ascending: false }).limit(1).single();
  if (!log) return await sendReply(replyToken, "❌ ไม่พบรายการคืนแต้ม");
  const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", memberId).single();
  const newTotal = (wallet?.point_balance || 0) + log.points_redeemed;
  await supabase.from("memberWallet").update({ point_balance: newTotal }).eq("member_id", memberId);
  await supabase.from("redeemlogs").update({ status: 'refunded' }).eq("id", log.id);
  await sendReply(replyToken, `💰 คืนแต้มสำเร็จ! ยอดรวม: ${newTotal}`);
}
async function sendReply(replyToken, text) {
  await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}
async function sendReplyPush(to, text) {
  await axios.post("https://api.line.me/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}
async function sendFlex(replyToken, flex) {
  await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken, messages: [flex] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 God Mode Server on port ${PORT}`));
