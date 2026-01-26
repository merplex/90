// update for railway v2 - Full Integration
require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
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
   1. WEBHOOK: ระบบจัดการข้อความและแอดมิน 🤖
==================================== */
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  
  for (let event of events) {
    const userId = event.source.userId;
    const ADMIN_IDS = ["U8d1d21082843a3aedb6cdd65f8779454", "Ud739afa32a9004fd318892feab424598"]; 

    // [LOG SYSTEM] จำลูกค้าล่าสุด
    if (event.type === "message" && !ADMIN_IDS.includes(userId)) {
      try {
        await supabase.from("last_chat").update({ last_user_id: userId }).eq("id", 1);
      } catch (e) { console.error("❌ Last Chat Error:", e.message); }
    }

    // [POSTBACK] ส่วนรับค่าจากการกดปุ่ม
    if (event.type === "postback") {
      const data = new URLSearchParams(event.postback.data);
      if (data.get("action") === "add" && ADMIN_IDS.includes(userId)) {
        const pts = parseInt(data.get("pts"));
        const customerUid = data.get("uid");
        await addPointToUser(customerUid, pts, event.replyToken);
      }
      continue; 
    }

    // [MESSAGE] จัดการข้อความ
    if (event.type === "message" && event.message.type === "text") {
      const userMsg = event.message.text.toUpperCase();

      try {
        // --- ADMIN COMMAND: CLAIM ---
        if (userMsg === "CLAIM" && ADMIN_IDS.includes(userId)) {
          const { data: chat } = await supabase.from("last_chat").select("last_user_id").eq("id", 1).single();
          if (chat?.last_user_id) {
            await sendAdminController(userId, chat.last_user_id);
          } else {
            await sendReply(event.replyToken, "❌ ยังไม่มีลูกค้าทักมาเลยค่ะ");
          }
          continue;
        }

        const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
        if (!member) continue; 

        if (userMsg === "CHECK_POINT") {
          const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
          await sendReply(event.replyToken, `🌟 คุณมีแต้มสะสม: ${wallet?.point_balance || 0} แต้ม`);
        } 
        else if (userMsg.startsWith("REDEEM_")) {
          const amount = parseInt(userMsg.split("_")[1]);
          const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
          if ((wallet?.point_balance || 0) < amount) {
            await sendReply(event.replyToken, `❌ แต้มไม่พอค่ะ (มี ${wallet.point_balance || 0} ใช้ ${amount})`);
          } else {
            await sendScanRequest(event.replyToken, amount);
          }
        }
        else if (userMsg === "REFUND") {
          await handleRefund(member.id, event.replyToken);
        }
        else if (userMsg.includes("จะเพิ่มแต้มให้") && ADMIN_IDS.includes(userId)) {
          const match = userMsg.match(/จะเพิ่มแต้มให้\s*(\d+)/);
          const pts = match ? parseInt(match[1]) : 0;
          const { data: chat } = await supabase.from("last_chat").select("last_user_id").eq("id", 1).single();
          if (pts > 0 && chat?.last_user_id) {
            await addPointToUser(chat.last_user_id, pts, event.replyToken);
          }
        }

      } catch (e) { console.error("💀 Webhook Loop Error:", e); }
    }
  }
  res.sendStatus(200);
});

/* ====================================
   2. ฟังก์ชันหลัก (ห้ามหายเด็ดขาด!)
==================================== */

// ✅ ฟังก์ชันเติมแต้ม (Add Point)
async function addPointToUser(targetUid, pts, replyToken) {
  try {
    const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", targetUid).single();
    if (!member) return;

    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
    const newTotal = (wallet?.point_balance || 0) + pts;

    await supabase.from("memberWallet").upsert({ member_id: member.id, point_balance: newTotal }, { onConflict: 'member_id' });

    if (replyToken) await sendReply(replyToken, `✅ เติมเรียบร้อย! +${pts} แต้ม (รวม: ${newTotal})`);
    await sendReplyPush(targetUid, `🎁 แอดมินเพิ่มแต้มพิเศษให้ ${pts} แต้มนะคะ! ยอดรวม: ${newTotal} แต้มค่ะ ✨`);
  } catch (e) { console.error("AddPoint Error:", e.message); }
}

// ✅ ฟังก์ชันส่งแผงควบคุมแอดมิน (Admin Controller)
async function sendAdminController(adminId, targetCustomerId) {
  const points = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100];
  const rows = [];
  for (let i = 0; i < points.length; i += 5) {
    rows.push({
      type: "box", layout: "horizontal", spacing: "sm",
      contents: points.slice(i, i + 5).map(pt => ({
        type: "button", height: "sm",
        action: { type: "postback", label: `+${pt}`, data: `action=add&pts=${pt}&uid=${targetCustomerId}`, displayText: `เติม ${pt} แต้ม` }
      }))
    });
  }

  const flexData = {
    type: "flex", altText: "Admin Control",
    contents: {
      type: "bubble",
      header: { type: "box", layout: "vertical", contents: [{ type: "text", text: "🕹 Admin Control Panel", weight: "bold", color: "#00b900" }] },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: rows }
    }
  };

  await axios.post("https://api.line.me/v2/bot/message/push", 
    { to: adminId, messages: [flexData] },
    { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}
  );
}

// ✅ ฟังก์ชันจัดการคืนแต้ม (Refund)
async function handleRefund(memberId, replyToken) {
  const { data: lastLog, error } = await supabase.from("redeemlogs").select("*")
    .eq("member_id", memberId).eq("status", 'pending').order("created_at", { ascending: false }).limit(1).single();

  if (error || !lastLog) return await sendReply(replyToken, "❌ ไม่พบรายการที่ค้างอยู่ค่ะ");

  const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", memberId).single();
  const newTotal = (wallet?.point_balance || 0) + lastLog.points_redeemed;

  await supabase.from("memberWallet").update({ point_balance: newTotal }).eq("member_id", memberId);
  await supabase.from("redeemlogs").update({ status: 'refunded', is_refunded: true }).eq("id", lastLog.id);
  await sendReply(replyToken, `💰 ระบบคืนแต้มให้แล้วค่ะ! (+${lastLog.points_redeemed} แต้ม)`);
}

// --- ฟังก์ชันเสริมส่งข้อความ (Utility Functions) ---
async function sendReply(replyToken, text) {
  await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken, messages: [{ type: "text", text }] }, 
  { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}

async function sendReplyPush(to, text) {
  await axios.post("https://api.line.me/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, 
  { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}

async function sendScanRequest(replyToken, amount) {
  const flex = { type: "flex", altText: "สแกนเพื่อใช้แต้ม", contents: { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "📷 พร้อมสแกน", weight: "bold", color: "#00b900" }, { type: "text", text: `สแกน QR เพื่อใช้ ${amount} แต้ม`, margin: "md" }] }, footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#00b900", action: { type: "uri", label: "เปิดกล้อง", uri: "https://line.me/R/nv/QRCodeReader" } }] } } };
  await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken, messages: [flex] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}

// API สำหรับสะสมแต้ม และ หักแต้ม (Consume/Redeem) - เขียนรวบย่อเพื่อความประหยัดเนื้อที่แต่ทำงานได้เหมือนเดิม
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    const { data: qr } = await supabase.from("qrPointToken").select("*").eq("qr_token", token).single();
    if (!qr || qr.is_used) return res.status(400).send("QR invalid/used");

    let { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
    if (!member) {
      const { data: nm } = await supabase.from("ninetyMember").insert({ line_user_id: userId }).select().single();
      member = nm;
    }

    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).maybeSingle();
    const newTotal = (w?.point_balance || 0) + qr.point_get;
    await supabase.from("memberWallet").upsert({ member_id: member.id, point_balance: newTotal }, { onConflict: 'member_id' });
    await supabase.from("qrPointToken").update({ is_used: true }).eq("qr_token", token);
    await sendReplyPush(userId, `สะสมสำเร็จ! +${qr.point_get} แต้ม (ยอดรวม: ${newTotal})`);
    res.send(`ยอดรวมตอนนี้: ${newTotal} แต้ม`);
  } catch (e) { res.status(500).send(e.message); }
});

app.get("/liff/redeem-execute", async (req, res) => {
  try {
    const { userId, amount, machine_id } = req.query;
    const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
    if (w.point_balance < amount) return res.status(400).send("แต้มไม่พอ");
    
    await supabase.from("memberWallet").update({ point_balance: w.point_balance - amount }).eq("member_id", m.id);
    await supabase.from("redeemlogs").insert({ member_id: m.id, machine_id, points_redeemed: amount, status: "pending" });
    await sendReplyPush(userId, `✅ ใช้แต้มสำเร็จ! หัก ${amount} แต้ม เครื่อง ${machine_id}`);
    res.send(`SUCCESS: MACHINE_${machine_id}_START`);
  } catch (e) { res.status(500).send(e.message); }
});

app.post("/create-qr", async (req, res) => {
  const { amount, machine_id } = req.body;
  const token = crypto.randomUUID();
  const point = Math.floor(amount / 10);
  const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}?bot_link=aggressive&token=${token}`;
  await supabase.from("qrPointToken").insert({ qr_token: token, scan_amount: amount, point_get: point, machine_id, qr_url: liffUrl });
  res.json({ qr_url: liffUrl });
});

setInterval(async () => {
  const oneMinAgo = new Date(Date.now() - 60000).toISOString();
  const { data: exp } = await supabase.from("redeemlogs").select("*, ninetyMember(line_user_id)").eq("status", 'pending').lt("created_at", oneMinAgo);
  if (exp) {
    for (let log of exp) {
      const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", log.member_id).single();
      await supabase.from("memberWallet").update({ point_balance: w.point_balance + log.points_redeemed }).eq("member_id", log.member_id);
      await supabase.from("redeemlogs").update({ status: 'refunded', is_refunded: true }).eq("id", log.id);
      if (log.ninetyMember?.line_user_id) await sendReplyPush(log.ninetyMember.line_user_id, `คืนแต้ม ${log.points_redeemed} เนื่องจากเครื่องไม่ตอบสนอง`);
    }
  }
}, 30000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
