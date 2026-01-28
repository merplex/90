// update for railway v4 - Pro UI & Flexible Request Version 🔐🌟
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
   1. CONSUME POINT API (สะสมแต้ม) 💰
==================================== */
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    if (!token || !userId) return res.status(400).send("ข้อมูลไม่ครบ");

    const { data: qrData, error: qrError } = await supabase.from("qrPointToken").select("*").eq("qr_token", token).single();
    if (qrError || !qrData) return res.status(404).send("ไม่พบรหัสคิวอาร์นี้");
    if (qrData.is_used) return res.status(400).send("คิวอาร์นี้ถูกใช้ไปแล้ว");

    // ล็อคคิวอาร์พร้อมลงชื่อคนใช้ทันที
    await supabase.from("qrPointToken").update({ 
      is_used: true, used_by: userId, used_at: new Date().toISOString() 
    }).eq("qr_token", token);

    let { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
    if (!member) {
      const { data: newM } = await supabase.from("ninetyMember").insert({ line_user_id: userId }).select().single();
      member = newM;
    }

    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
    const newTotal = (wallet?.point_balance || 0) + qrData.point_get;
    await supabase.from("memberWallet").upsert({ member_id: member.id, point_balance: newTotal }, { onConflict: 'member_id' });

    const successMsg = `สะสมสำเร็จ! +${qrData.point_get} แต้ม (ยอดรวม: ${newTotal})`;
    await sendReplyPush(userId, successMsg);
    res.send(successMsg);
  } catch (err) { res.status(500).send(err.message); }
});
// รับแต้มจาก liff.html ที่มีปุ่มกดเลือกแต้มแล้ว ค่าสแกนเพื่อรับ หมายเลขเครื่องจาก qr ของ hmi
// --- เพิ่ม Endpoint นี้ใน index.js (วางไว้ก่อน app.listen) ---
app.get("/api/get-user-points", async (req, res) => {
    const { userId } = req.query;
    try {
        const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
        if (!m) return res.json({ points: 0 });
        const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
        res.json({ points: w?.point_balance || 0 });
    } catch (e) { res.status(500).send(e.message); }
});

/* ====================================
   2. REDEEM API (หักแต้มหน้าตู้) 💸
==================================== */
app.get("/liff/redeem-execute", async (req, res) => {
  try {
    const { userId, amount, machine_id } = req.query;
    const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
    
    if (w.point_balance < amount) return res.status(400).send("แต้มไม่พอ");

    const newBalance = w.point_balance - amount;
    await supabase.from("memberWallet").update({ point_balance: newBalance }).eq("member_id", m.id);
    await supabase.from("redeemlogs").insert({ member_id: m.id, machine_id, points_redeemed: parseInt(amount), status: "pending" });

    // ✅ UI ใช้แต้มสำเร็จ (แบ่งบรรทัดตามบรีฟ)
    await sendReplyPush(userId, `✅ ใช้แต้มสำเร็จ!\nหักไป: ${amount} แต้ม\nเครื่อง: ${machine_id}\nคงเหลือ: ${newBalance} แต้ม`);
    res.send(`SUCCESS: MACHINE_${machine_id}_START`);
  } catch (err) { res.status(500).send(err.message); }
});

/* ====================================
   3. WEBHOOK (ระบบจัดการแชท & แอดมิน) 🤖
==================================== */
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  for (let event of events) {
    const userId = event.source.userId;
    const ADMIN_IDS = ["U8d1d21082843a3aedb6cdd65f8779454", "Ud739afa32a9004fd318892feab424598"]; 

    if (event.type === "message" && event.message.type === "text") {
      const rawMsg = event.message.text.trim();
      const userMsg = rawMsg.toUpperCase(); 

            try {
        const pointMatch = rawMsg.match(/(\d+)\s*แต้ม/);

        // 1️⃣ คำสั่งที่ทุกคนใช้ได้ (ไม่ต้องเช็กว่าเป็นสมาชิกไหม)
        if (userMsg === "USER_LINE") {
            await sendReply(event.replyToken, `รหัส User ID ของคุณคือ:\n${userId}`);
            return; 
        }

        // 2️⃣ ระบบคุยธรรมชาติ (ขอแต้ม)
        if (pointMatch && !ADMIN_IDS.includes(userId)) { 
            const pts = parseInt(pointMatch[1]);
            await supabase.from("point_requests").insert({ 
                line_user_id: userId, points: pts, request_at: new Date().toISOString() 
            });
            console.log(`📝 บันทึกคำขอใหม่: User ${userId} ขอ ${pts} แต้ม`);
        }
        // 3️⃣ ส่วนแอดมินอนุมัติ (OK / โอเค)
        else if ((userMsg === "OK" || userMsg === "โอเค") && ADMIN_IDS.includes(userId)) {
            const oneMinAgo = new Date(Date.now() - 60000).toISOString();
            const { data: reqRecord } = await supabase.from("point_requests")
                .select("*").gt("request_at", oneMinAgo).order("request_at", { ascending: false }).limit(1).single();

            if (reqRecord) {
                await addPointToUser(reqRecord.line_user_id, reqRecord.points, event.replyToken);
                await supabase.from("point_requests").delete().eq("id", reqRecord.id);
            } else {
                await sendReply(event.replyToken, `❌ ไม่พบรายการที่ค้างอยู่ค่ะ`);
            }
        }
        // 4️⃣ ระบบที่ต้องเป็นสมาชิกก่อน (CHECK, REDEEM, REFUND)
        else {
            const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
            if (member) {
                if (userMsg === "CHECK_POINT") {
                    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
                    await sendReply(event.replyToken, `🌟 คุณมีแต้มสะสม: ${wallet?.point_balance || 0} แต้ม`);
                } 
                else if (userMsg.startsWith("REDEEM_")) {
                    const amt = parseInt(userMsg.split("_")[1]);
                    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
                    if ((w?.point_balance || 0) < amt) await sendReply(event.replyToken, `❌ แต้มไม่พอค่ะ`);
                    else await sendScanRequest(event.replyToken, amt);
                }
                else if (userMsg === "REFUND") {
                    await handleRefund(member.id, event.replyToken);
                }
            }
        }
      } catch (e) { console.error(e.message); }

    }
  }
  res.sendStatus(200);
});

/* ====================================
   4. HELPER FUNCTIONS (ฟังก์ชันเสริมความโปร) 🛠️
==================================== */

// ✅ อนุมัติเติมแต้ม (Admin OK)
async function addPointToUser(targetUid, pts, replyToken) {
  try {
    const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", targetUid).single();
    if (!m) return;
    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
    const newTotal = (w?.point_balance || 0) + pts;
    await supabase.from("memberWallet").upsert({ member_id: m.id, point_balance: newTotal }, { onConflict: 'member_id' });
    
    // ✅ UI อนุมัติสำเร็จ
    const adminMsg = `✅ อนุมัติเติมแต้มเรียบร้อยค่ะ!\n\n+ เติมให้: ${pts} แต้ม\n🌟 ยอดรวมปัจจุบัน: ${newTotal} แต้ม`;
    if (replyToken) await sendReply(replyToken, adminMsg);
    await sendReplyPush(targetUid, `🎊 แอดมินเติมแต้มพิเศษให้ ${pts} แต้ม\nยอดรวมของคุณคือ ${newTotal} แต้มค่ะ ✨`);
  } catch (e) { console.error(e); }
}

// ✅ คืนแต้ม (Manual Refund)
async function handleRefund(memberId, replyToken) {
    const { data: log } = await supabase.from("redeemlogs").select("*").eq("member_id", memberId).eq("status", 'pending').order("created_at", { ascending: false }).limit(1).single();
    
    if (!log) return await sendReply(replyToken, `❌ ไม่พบรายการที่ค้างอยู่ค่ะ\n(รายการล่าสุดอาจจะทำงานสำเร็จไปแล้ว หรือยังไม่มีการหักแต้มเข้ามา)`);

    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", memberId).single();
    const newTotal = (wallet?.point_balance || 0) + log.points_redeemed;

    await supabase.from("memberWallet").update({ point_balance: newTotal }).eq("member_id", memberId);
    await supabase.from("redeemlogs").update({ status: 'refunded', is_refunded: true }).eq("id", log.id);

    // ✅ UI คืนแต้มสำเร็จ
    const successRefund = `💰 ระบบคืนแต้มให้แล้วค่ะ!\n\n+ คืนให้: ${log.points_redeemed} แต้ม\n🌟 ยอดรวมปัจจุบัน: ${newTotal} แต้ม\n(รายการเครื่อง ${log.machine_id} ถูกยกเลิกเรียบร้อย)`;
    await sendReply(replyToken, successRefund);
}

// ✅ LINE API Helpers
async function sendReply(replyToken, text) {
  await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}
async function sendReplyPush(to, text) {
  await axios.post("https://api.line.me/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}
async function sendScanRequest(replyToken, amount) {
  const flex = { type: "flex", altText: "เปิดกล้อง", contents: { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "📷 พร้อมสแกน", weight: "bold", color: "#00b900" }, { type: "text", text: `สแกน QR เพื่อใช้ ${amount} แต้ม`, margin: "md" }] }, footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#00b900", action: { type: "uri", label: "เปิดกล้อง", uri: "https://line.me/R/nv/QRCodeReader" } }] } } };
  await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken, messages: [flex] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}

// ✅ Auto Refund (ทำงานทุก 30 วินาที)
setInterval(async () => {
  try {
    const oneMinAgo = new Date(Date.now() - 60000).toISOString();
    const { data: exp } = await supabase.from("redeemlogs").select("*, ninetyMember(line_user_id)").eq("status", 'pending').lt("created_at", oneMinAgo);
    if (exp && exp.length > 0) {
      for (let log of exp) {
        const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", log.member_id).single();
        const newTot = (w?.point_balance || 0) + log.points_redeemed;
        await supabase.from("memberWallet").update({ point_balance: newTot }).eq("member_id", log.member_id);
        await supabase.from("redeemlogs").update({ status: 'refunded', is_refunded: true }).eq("id", log.id);
        if (log.ninetyMember?.line_user_id) {
            await sendReplyPush(log.ninetyMember.line_user_id, `💰 คืนแต้มอัตโนมัติสำเร็จ!\n\n+ คืนให้: ${log.points_redeemed} แต้ม\n🌟 ยอดรวมปัจจุบัน: ${newTot} แต้ม\n(เนื่องจากเครื่อง ${log.machine_id} ไม่ตอบสนอง)`);
        }
      }
    }
  } catch (err) { console.error(err.message); }
}, 30000);

/* ====================================
   5. MACHINE CONFIRMATION (ตู้กดยืนยัน) ⚙️
==================================== */
app.get("/api/machine-confirm", async (req, res) => {
  try {
    const { machine_id } = req.query;

    if (!machine_id) return res.status(400).send("MISSING_MACHINE_ID");

    // 1. ค้นหา Log รายการล่าสุดที่ยังเป็น 'pending' ของเครื่องนี้
    const { data: log, error } = await supabase
      .from("redeemlogs")
      .select("*")
      .eq("machine_id", machine_id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !log) {
      console.log(`❌ No pending log found for machine: ${machine_id}`);
      return res.status(404).send("NO_PENDING_TRANSACTION");
    }

    // 2. อัปเดตสถานะเป็น 'success' เพื่อหยุดระบบ Auto Refund
    await supabase
      .from("redeemlogs")
      .update({ status: "success" })
      .eq("id", log.id);

    console.log(`✅ Transaction ${log.id} confirmed for machine ${machine_id}`);
    res.send("CONFIRM_SUCCESS");

  } catch (err) {
    console.error("Confirmation Error:", err.message);
    res.status(500).send("INTERNAL_ERROR");
  }
});

// API อื่นๆ
app.post("/create-qr", async (req, res) => {
  const { amount, machine_id } = req.body;
  const token = crypto.randomUUID();
  const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}?bot_link=aggressive&token=${token}`;
  await supabase.from("qrPointToken").insert({ qr_token: token, scan_amount: amount, point_get: Math.floor(amount/10), machine_id, qr_url: liffUrl });
  res.json({ qr_url: liffUrl });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Professional Server running on port ${PORT}`));
