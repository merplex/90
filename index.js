// update for railway v2 - Full Integrity Version 🔐
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

// --- Config Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

/* ====================================
   1. CONSUME POINT API (ฉบับแก้ไข: ล็อคคิวอาร์ + บันทึก used_by 🛡️)
==================================== */
app.get("/liff/consume", async (req, res) => {
  console.log("🔵 Step 1: เริ่มกระบวนการตรวจสอบการสแกน");
  try {
    const { token, userId } = req.query;
    if (!token || !userId) return res.status(400).send("ข้อมูลไม่ครบ");

    // 1.1 ตรวจสอบคิวอาร์ในตาราง
    const { data: qrData, error: qrError } = await supabase
      .from("qrPointToken")
      .select("*")
      .eq("qr_token", token)
      .single();

    if (qrError || !qrData) return res.status(404).send("ไม่พบรหัสคิวอาร์นี้");
    if (qrData.is_used) return res.status(400).send("คิวอาร์นี้ถูกใช้ไปแล้ว");

    // ✨ [จุดแก้ไขสำคัญ] สั่งล็อค QR ทันที และระบุชื่อคนใช้ (used_by)
    // เราจะทำขั้นตอนนี้ก่อนเติมแต้ม เพื่อป้องกันการสแกนซ้อนค่ะ
    const { error: updateQrError } = await supabase
      .from("qrPointToken")
      .update({ 
        is_used: true, 
        used_by: userId, 
        used_at: new Date().toISOString() 
      })
      .eq("qr_token", token);

    if (updateQrError) throw new Error("ไม่สามารถล็อคคิวอาร์ได้: " + updateQrError.message);

    // 1.2 จัดการข้อมูลสมาชิก (ถ้าไม่เจอให้สมัครใหม่)
    let { data: memberData } = await supabase
      .from("ninetyMember")
      .select("id")
      .eq("line_user_id", userId)
      .single();

    if (!memberData) {
      const { data: newMember, error: insertError } = await supabase
        .from("ninetyMember")
        .insert({ line_user_id: userId })
        .select().single();
      
      if (insertError) throw new Error("สมัครสมาชิกอัตโนมัติไม่สำเร็จ");
      memberData = newMember;
    }

    // 1.3 คำนวณและอัปเดตแต้มลง Wallet
    const { data: walletData } = await supabase
      .from("memberWallet")
      .select("point_balance")
      .eq("member_id", memberData.id)
      .single();

    const currentPoint = walletData ? (walletData.point_balance || 0) : 0;
    const newTotal = currentPoint + qrData.point_get;

    const { error: walletUpdateError } = await supabase
      .from("memberWallet")
      .upsert({ 
          member_id: memberData.id, 
          point_balance: newTotal 
      }, { onConflict: 'member_id' });

    if (walletUpdateError) throw new Error("อัปเดตกระเป๋าเงินไม่สำเร็จ");

    // 1.4 ส่ง LINE แจ้งเตือนลูกค้า
    try {
      await sendReplyPush(userId, `สะสมสำเร็จ! +${qrData.point_get} แต้ม (ยอดรวม: ${newTotal})`);
    } catch (e) { console.log("⚠️ LINE Push Failed"); }

    res.send(`สะสมสำเร็จ! ยอดรวมตอนนี้: ${newTotal} แต้มค่ะ`);

  } catch (err) {
    console.error("💀 Error:", err.message);
    res.status(500).send("เกิดข้อผิดพลาด: " + err.message);
  }
});

/* ====================================
   2. CREATE QR API (สร้างคิวอาร์รับแต้ม 📹)
==================================== */
app.post("/create-qr", async (req, res) => {
  try {
    const { amount, machine_id } = req.body;
    if (!amount || !machine_id) return res.status(400).json({ error: "Missing data" });

    const token = crypto.randomUUID(); 
    const point = Math.floor(amount / 10);
    const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}?bot_link=aggressive&token=${token}`;

    const { data, error } = await supabase.from("qrPointToken").insert({
      qr_token: token,
      scan_amount: amount,
      point_get: point,
      machine_id: machine_id,
      qr_url: liffUrl,
      is_used: false
    }).select();

    if (error) throw error;
    res.json({ qr_url: liffUrl });
  } catch (err) {
    console.error("💀 FATAL ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ====================================
   3. WEBHOOK: ระบบจัดการข้อความและแอดมิน 🤖
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
        // --- 🟢 ส่วนที่ 1: ระบบคุยธรรมชาติ (ขอแต้ม / อนุมัติ) ---
        if (rawMsg.match(/^\d+\s*แต้ม$/)) { 
          const pointsRequest = parseInt(rawMsg.replace("แต้ม", "").trim());
          if (pointsRequest > 0) {
            await supabase.from("point_requests").delete().eq("line_user_id", userId);
            await supabase.from("point_requests").insert({
              line_user_id: userId,
              points: pointsRequest,
              request_at: new Date().toISOString()
            });
            console.log(`📝 User ${userId} ขอมา ${pointsRequest} แต้ม`);
          }
        }
        else if ((userMsg === "OK" || userMsg === "โอเค") && ADMIN_IDS.includes(userId)) {
          const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
          const { data: request } = await supabase.from("point_requests").select("*")
            .gt("request_at", oneMinuteAgo).order("request_at", { ascending: false }).limit(1).single();

          if (request) {
            await addPointToUser(request.line_user_id, request.points, event.replyToken);
            await supabase.from("point_requests").delete().eq("id", request.id);
          }
        }
        // --- 🔵 ส่วนที่ 2: ระบบเดิม (CHECK, REDEEM, REFUND) ---
        else {
            const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
            if (member) {
                if (userMsg === "CHECK_POINT") {
                    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
                    await sendReply(event.replyToken, `🌟 คุณมีแต้มสะสม: ${wallet?.point_balance || 0} แต้ม`);
                } 
                else if (userMsg.startsWith("REDEEM_")) {
                    const amount = parseInt(userMsg.split("_")[1]);
                    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
                    if ((wallet?.point_balance || 0) < amount) {
                        await sendReply(event.replyToken, `❌ แต้มไม่พอค่ะ (มี ${wallet?.point_balance || 0} ใช้ ${amount})`);
                    } else {
                        await sendScanRequest(event.replyToken, amount);
                    }
                }
                else if (userMsg === "REFUND") {
                    await handleRefund(member.id, event.replyToken);
                }
            }
        }
      } catch (e) { console.error("💀 Webhook Error:", e.message); }
    }
  }
  res.sendStatus(200);
});

/* ====================================
   4. REDEEM API: สำหรับหักแต้มหน้าตู้ 💸
==================================== */
app.get("/liff/redeem-execute", async (req, res) => {
  try {
    const { userId, amount, machine_id } = req.query;
    const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
    if (!member) return res.status(404).send("ไม่พบสมาชิก");

    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
    if (wallet.point_balance < amount) return res.status(400).send("แต้มไม่พอ");

    await supabase.from("memberWallet").update({ point_balance: wallet.point_balance - amount }).eq("member_id", member.id);
    await supabase.from("redeemlogs").insert({
      member_id: member.id,
      machine_id: machine_id,
      points_redeemed: parseInt(amount),
      status: "pending"
    });

    await sendReplyPush(userId, `✅ ใช้แต้มสำเร็จ! หัก ${amount} แต้ม เครื่อง ${machine_id}`);
    res.send(`SUCCESS: MACHINE_${machine_id}_START`);
  } catch (err) { res.status(500).send(err.message); }
});

/* ====================================
   5. HELPER FUNCTIONS: ฟังก์ชันเสริมต่างๆ 🛠️
==================================== */

// --- ฟังก์ชันเติมแต้ม Manual ---
async function addPointToUser(targetUid, pts, replyToken) {
  try {
    const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", targetUid).single();
    if (!member) return;
    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
    const newTotal = (wallet?.point_balance || 0) + pts;

    await supabase.from("memberWallet").upsert({ member_id: member.id, point_balance: newTotal }, { onConflict: 'member_id' });
    if (replyToken) await sendReply(replyToken, `✅ อนุมัติเติม ${pts} แต้มเรียบร้อยค่ะ\n🌟 ยอดใหม่: ${newTotal}`);
    await sendReplyPush(targetUid, `🎊 แอดมินเติมแต้มพิเศษให้ ${pts} แต้ม (ยอดรวม: ${newTotal}) ✨`);
  } catch (e) { console.error(e); }
}

// --- ฟังก์ชันจัดการ Refund ---
async function handleRefund(memberId, replyToken) {
    const { data: lastLog, error } = await supabase.from("redeemlogs").select("*")
        .eq("member_id", memberId).eq("status", 'pending').order("created_at", { ascending: false }).limit(1).single();

    if (error || !lastLog) return await sendReply(replyToken, "❌ ไม่พบรายการที่คืนได้ค่ะ");

    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", memberId).single();
    const newTotal = (wallet?.point_balance || 0) + lastLog.points_redeemed;

    await supabase.from("memberWallet").update({ point_balance: newTotal }).eq("member_id", memberId);
    await supabase.from("redeemlogs").update({ status: 'refunded', is_refunded: true }).eq("id", lastLog.id);
    await sendReply(replyToken, `💰 คืนแต้มให้แล้วค่ะ! (+${lastLog.points_redeemed} แต้ม)`);
}

// --- ฟังก์ชันส่งข้อความ LINE ---
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

// --- Auto Refund Interval (รันทุก 30 วินาที) ---
setInterval(async () => {
  try {
    const oneMinAgo = new Date(Date.now() - 60000).toISOString();
    const { data: exp } = await supabase.from("redeemlogs").select("*, ninetyMember(line_user_id)").eq("status", 'pending').lt("created_at", oneMinAgo);
    if (exp && exp.length > 0) {
      for (let log of exp) {
        const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", log.member_id).single();
        await supabase.from("memberWallet").update({ point_balance: (w?.point_balance || 0) + log.points_redeemed }).eq("member_id", log.member_id);
        await supabase.from("redeemlogs").update({ status: 'refunded', is_refunded: true }).eq("id", log.id);
        if (log.ninetyMember?.line_user_id) await sendReplyPush(log.ninetyMember.line_user_id, `🔔 คืนแต้มอัตโนมัติ ${log.points_redeemed} แต้มค่ะ`);
      }
    }
  } catch (err) { console.error("❌ Auto Refund Error:", err.message); }
}, 30000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
