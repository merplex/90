// update for railway v1
require("dotenv").config();
// ... โค้ดเดิม ...


require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // <--- ✨ เพิ่มบรรทัดนี้ลงไปค่ะเปรม


// --- 1. ส่วนสำคัญที่สุด: Health Check ---
// Railway จะยิงมาที่นี่ ถ้าตอบ 200 OK แสดงว่ารอด!
//app.get("/", (req, res) => {
//  console.log("🟢 Health Check: Railway is checking me!");
//  res.status(200).send("I am alive and ready!");
//});

// --- Config Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

/* ====================================
   CONSUME POINT API (รองรับ Member & Wallet 💰)
==================================== */
app.get("/liff/consume", async (req, res) => {
  console.log("🔵 Step 1: เริ่มกระบวนการตรวจสอบ");
  try {
    const { token, userId } = req.query;
    if (!token || !userId) return res.status(400).send("ข้อมูลไม่ครบ");

    // 1. ตรวจสอบ Token ในตาราง qrPointToken
    const { data: qrData, error: qrError } = await supabase
      .from("qrPointToken")
      .select("*")
      .eq("qr_token", token)
      .single();

    if (qrError || !qrData) return res.status(404).send("ไม่พบรหัสคิวอาร์นี้");
    if (qrData.is_used) return res.status(400).send("คิวอาร์นี้ถูกใช้ไปแล้ว");

    // 2. ค้นหา ID สมาชิกจากตาราง ninetyMember โดยใช้ line_user_id
    const { data: memberData, error: memberError } = await supabase
      .from("ninetyMember")
      .select("id")
      .eq("line_user_id", userId)
      .single();

    if (memberError || !memberData) {
        return res.status(404).send("ไม่พบข้อมูลสมาชิก (กรุณาลงทะเบียนก่อน)");
    }

    const member_id = memberData.id;

    // 3. ดึงแต้มปัจจุบันจาก memberWallet โดยใช้ member_id
    const { data: walletData } = await supabase
      .from("memberWallet")
      .select("point_balance")
      .eq("member_id", member_id)
      .single();

    const currentPoint = walletData ? (walletData.point_balance || 0) : 0;
    const newTotal = currentPoint + qrData.point_get;

    // 4. อัปเดตแต้มใน memberWallet (UPSERT)
    const { error: walletUpdateError } = await supabase
      .from("memberWallet")
      .upsert({ 
          member_id: member_id, 
          point_balance: newTotal 
      }, { onConflict: 'member_id' });

    if (walletUpdateError) throw new Error("Wallet Update Failed: " + walletUpdateError.message);

    // 5. มาร์คว่า QR ใช้แล้ว
    await supabase.from("qrPointToken").update({ is_used: true }).eq("qr_token", token);

    // 6. ส่ง LINE แจ้งเตือน (Try-Catch แยก)
    try {
      if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
        await axios.post("https://api.line.me/v2/bot/message/push", {
          to: userId,
          messages: [{ type: "text", text: `สะสมสำเร็จ! +${qrData.point_get} แต้ม (ยอดรวม: ${newTotal})` }]
        }, {
          headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
        });
      }
    } catch (e) { console.log("⚠️ LINE Push Failed"); }

    res.send(`สะสมสำเร็จ! ยอดรวมตอนนี้: ${newTotal} แต้ม`);

  } catch (err) {
    console.error("💀 Error:", err.message);
    res.status(500).send("เกิดข้อผิดพลาด: " + err.message);
  }
});

/* =======================
   CREATE QR API (แบบติดกล้องวงจรปิด 📹)
======================= */
app.post("/create-qr", async (req, res) => {
  console.log("📍 STEP 1: Request เข้ามาแล้ว");

  try {
    const { amount, machine_id } = req.body;
    console.log(`📍 STEP 2: รับค่า amount=${amount}, machine=${machine_id}`);

    if (!amount || !machine_id) {
        console.log("❌ STEP 2.5: ข้อมูลไม่ครบ");
        return res.status(400).json({ error: "Missing data" });
    }

    // สร้าง Token
    const token = crypto.randomUUID(); 
    console.log(`📍 STEP 3: สร้าง Token สำเร็จ (${token})`);

    const point = Math.floor(amount / 10);
    const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}?bot_link=aggressive&token=${token}`;


    console.log("📍 STEP 4: กำลังส่งเข้า Supabase...");

    // บันทึก
    const { data, error } = await supabase.from("qrPointToken").insert({
      qr_token: token,
      scan_amount: amount,
      point_get: point,
      machine_id: machine_id,
      qr_url: liffUrl,
      is_used: false
    }).select();

    if (error) {
        console.error("❌ STEP 5: Supabase Error!", error);
        throw error;
    }

    console.log("✅ STEP 6: บันทึกสำเร็จ! Data:", data);
    res.json({ qr_url: liffUrl });

  } catch (err) {
    console.error("💀 FATAL ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});
/* ====================================
   1. WEBHOOK: เช็กสิทธิ์ก่อนใช้แต้ม 🔍
==================================== */
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  for (let event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const userId = event.source.userId;
      const userMsg = event.message.text.toUpperCase(); // แปลงเป็นตัวพิมพ์ใหญ่ทั้งหมด

      try {
        const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
        if (!member) return res.sendStatus(200);

        if (userMsg === "CHECK_POINT") {
          const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
          await sendReply(event.replyToken, `🌟 คุณมีแต้มสะสม: ${wallet?.point_balance || 0} แต้ม`);
        } 
        
        else if (userMsg.startsWith("REDEEM_")) {
          const amount = parseInt(userMsg.split("_")[1]);
          const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
          
          if ((wallet?.point_balance || 0) < amount) {
            await sendReply(event.replyToken, `❌ แต้มไม่พอค่ะ (มี ${wallet.point_balance} ใช้ ${amount})`);
          } else {
            // ส่ง Flex Message บอกให้สแกน (ยังไม่หักแต้ม!)
            await sendScanRequest(event.replyToken, amount);
          }
        }
        // ... ภายในส่วน app.post("/webhook", ...) ...
        // ... หลังจากการหาค่า member ...

        else if (userMsg === "REFUND") {
          console.log(`💰 [REFUND] เริ่มตรวจสอบรายการคืนแต้มสำหรับ User: ${userId}`);
  
          try {
          // 1. ค้นหารายการล่าสุดจากตาราง redeemlogs ที่สถานะยังเป็น 'pending' เท่านั้น
            const { data: lastLog, error: logError } = await supabase
            .from("redeemlogs")
            .select("*")
            .eq("member_id", member.id)
            .eq("status", 'pending') // 🔒 🔐 คืนได้เฉพาะรายการที่ยังไม่สำเร็จ (pending)
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

          // กรณีหาไม่เจอ หรือเครื่องทำงานสำเร็จ (complete) ไปแล้ว
          if (logError || !lastLog) {
            console.log("❌ [REFUND] ไม่พบรายการที่คืนได้");
            return await sendReply(event.replyToken, "❌ ไม่พบรายการที่ค้างอยู่ค่ะ\n(รายการล่าสุดอาจจะทำงานสำเร็จไปแล้ว หรือยังไม่มีการหักแต้มเข้ามา)");
          }

          // 2. ดึงแต้มปัจจุบันจาก Wallet เพื่อบวกคืน
          const { data: wallet } = await supabase
            .from("memberWallet")
            .select("point_balance")
            .eq("member_id", member.id)
            .single();

          const currentBalance = wallet ? (wallet.point_balance || 0) : 0;
          const newTotal = currentBalance + lastLog.points_redeemed;

          // 3. ทำการคืนแต้มเข้า Wallet และเปลี่ยนสถานะ Log เป็น 'refunded'
          // อัปเดต Wallet
          await supabase.from("memberWallet")
            .update({ point_balance: newTotal })
            .eq("member_id", member.id);

          // อัปเดตสถานะใน Log เพื่อปิดรายการ
          await supabase.from("redeemlogs")
            .update({ 
              status: 'refunded', 
              is_refunded: true 
            })
            .eq("id", lastLog.id);

          console.log(`✅ [REFUND] คืนแต้มสำเร็จ: ${lastLog.points_redeemed} pts`);

          // 4. แจ้งผลทาง LINE
          await sendReply(event.replyToken, `💰 ระบบคืนแต้มให้แล้วค่ะ!\n\n+ คืนให้: ${lastLog.points_redeemed} แต้ม\n🌟 ยอดรวมปัจจุบัน: ${newTotal} แต้ม\n(รายการเครื่อง ${lastLog.machine_id} ถูกยกเลิกเรียบร้อย)`);

        } catch (err) {
          console.error("💀 [REFUND ERROR]:", err.message);
          await sendReply(event.replyToken, "⚠️ เกิดข้อผิดพลาดในระบบคืนแต้ม กรุณาลองใหม่ภายหลังค่ะ");
        }
      } // <--- ปิด else if (userMsg === "REFUND")
    } catch (e) { console.error(e); } // <--- ปิด try ของ webhook หลัก
  } // <--- ปิด if (event.type === "message")
} // <--- ปิด for (let event of events)
res.sendStatus(200);
});


/* ====================================
   API: สำหรับหักแต้ม (ใช้ชื่อตัวแปรเดียวกับระบบรับแต้ม) 💸
==================================== */
app.get("/liff/redeem-execute", async (req, res) => {
  console.log("💳 [REDEEM] เริ่มกระบวนการตัดแต้ม...");
  
  try {
    // ✨ เปลี่ยนชื่อตามที่เปรมต้องการ: amount และ machine_id
    const { userId, amount, machine_id } = req.query;

    if (!userId || !amount || !machine_id) {
      return res.status(400).send("ข้อมูลไม่ครบ (ต้องการ userId, amount, machine_id)");
    }

    // 1. หาข้อมูลสมาชิก
    const { data: member } = await supabase
      .from("ninetyMember")
      .select("id")
      .eq("line_user_id", userId)
      .single();

    if (!member) return res.status(404).send("ไม่พบสมาชิกในระบบ");

    // 2. เช็กยอดเงิน/แต้มล่าสุด
    const { data: wallet } = await supabase
      .from("memberWallet")
      .select("point_balance")
      .eq("member_id", member.id)
      .single();

    const currentBalance = wallet ? wallet.point_balance : 0;
    const redeemAmount = parseInt(amount);

    if (currentBalance < redeemAmount) {
      return res.status(400).send(`ยอดแต้มไม่พอ (มี ${currentBalance}, จะใช้ ${redeemAmount})`);
    }

    // 3. หักแต้มจริงใน Database
    const newBalance = currentBalance - redeemAmount;
    await supabase
      .from("memberWallet")
      .update({ point_balance: newBalance })
      .eq("member_id", member.id);
    
    //3.5 ✨ เพิ่มตรงนี้: บันทึกประวัติการหักแต้มลงในตาราง redeemLogs
    await supabase.from("redeemlogs").insert({
      member_id: member.id,
      machine_id: machine_id,
      points_redeemed: parseInt(amount),
      status: "pending"  // รอการยืนยันจากตู้ HMI
    });

    // 4. ส่ง Push Message แจ้งเตือนลูกค้า
    await sendReplyPush(userId, `✅ ใช้แต้มสำเร็จ! \nหักไป: ${redeemAmount} แต้ม \nเครื่อง: ${machine_id} \nคงเหลือ: ${newBalance} แต้ม`);

    // 5. ตอบกลับหน้าจอ LIFF (เพื่อให้ตู้ HMI อ่านค่า SUCCESS ได้)
    res.send(`SUCCESS: MACHINE_${machine_id}_START`);

  } catch (err) {
    console.error("Redeem Error:", err.message);
    res.status(500).send("System Error: " + err.message);
  }
});

// --- ฟังก์ชันช่วยส่งข้อความตอบกลับ (ต้องมีไว้ท้ายไฟล์นะ!) ---
async function sendReply(replyToken, text) {
  try {
    await axios.post("https://api.line.me/v2/bot/message/reply", {
      replyToken: replyToken,
      messages: [{ type: "text", text: text }]
    }, {
      headers: { 
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log("✅ Reply Sent Successfully");
  } catch (e) {
    console.error("❌ Reply Error:", e.response ? e.response.data : e.message);
  }
}

// --- ฟังก์ชันส่ง Flex Message สำหรับปุ่มเปิดกล้องสแกน ---
async function sendScanRequest(replyToken, amount) {
  const flexData = {
    type: "flex",
    altText: "ยืนยันการใช้แต้ม",
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", contents: [
          { type: "text", text: "📷 พร้อมใช้งานแล้ว", weight: "bold", size: "lg", color: "#00b900" },
          { type: "text", text: `กดปุ่มด้านล่างเพื่อสแกน QR ที่เครื่องเพื่อใช้ ${amount} แต้ม`, wrap: true, margin: "md" }
        ]
      },
      footer: {
        type: "box", layout: "vertical", contents: [
          {
            type: "button",
            style: "primary",
            color: "#00b900",
            action: {
              type: "uri",
              label: "เปิดกล้องสแกน",
              uri: "https://line.me/R/nv/QRCodeReader" // คำสั่งเปิดกล้อง LINE
            }
          }
        ]
      }
    }
  };

  try {
    await axios.post("https://api.line.me/v2/bot/message/reply", {
      replyToken: replyToken,
      messages: [flexData]
    }, {
      headers: { 
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ ส่งปุ่มเปิดกล้อง (${amount} แต้ม) เรียบร้อย`);
  } catch (e) {
    console.error("❌ ส่ง Flex Message ไม่ได้:", e.response ? e.response.data : e.message);
  }
}
// --- ฟังก์ชันส่ง Push Message (สำหรับแจ้งเตือนตอนหักแต้มสำเร็จ) ---
async function sendReplyPush(to, text) {
  try {
    await axios.post("https://api.line.me/v2/bot/message/push", {
      to: to,
      messages: [{ type: "text", text: text }]
    }, {
      headers: { 
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log("✅ Push Notification Sent");
  } catch (e) {
    console.error("❌ Push Error:", e.response ? e.response.data : e.message);
  }
}
/* ====================================
   จุดที่ 3: Auto Refund (ตัวที่ปรับปรุงแล้ว)
==================================== */
setInterval(async () => {
  console.log("🕒 Checking for expired pending transactions...");
  try {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    
    // ดึงรายการที่ค้าง pending เกิน 1 นาที
    const { data: expired } = await supabase
      .from("redeemlogs")
      .select("*, ninetyMember(line_user_id)")
      .eq("status", 'pending')
      .lt("created_at", oneMinuteAgo);

    if (expired && expired.length > 0) {
      for (let log of expired) {
        // 1. ดึงแต้มปัจจุบันของลูกค้า
        const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", log.member_id).single();
        const currentBal = w ? w.point_balance : 0;
        
        // 2. คืนแต้มเข้า Wallet
        await supabase.from("memberWallet").update({ point_balance: currentBal + log.points_redeemed }).eq("member_id", log.member_id);
        
        // 3. ปิดสถานะรายการเป็น refunded
        await supabase.from("redeemlogs").update({ status: 'refunded', is_refunded: true }).eq("id", log.id);
        
        // 4. แจ้งลูกค้าผ่าน Push (ใช้ฟังก์ชัน sendReplyPush ที่เราทำไว้)
        if (log.ninetyMember && log.ninetyMember.line_user_id) {
          await sendReplyPush(log.ninetyMember.line_user_id, `🔔 ระบบคืนแต้มอัตโนมัติ ${log.points_redeemed} แต้ม\nเนื่องจากเครื่อง ${log.machine_id} ไม่ตอบสนองภายใน 1 นาทีค่ะ`);
        }
        console.log(`✅ Auto Refunded ${log.points_redeemed} pts to ${log.member_id}`);
      }
    }
  } catch (err) {
    console.error("❌ Auto Refund Error:", err.message);
  }
}, 30000); // รันทุก 30 วินาที


// --- Start Server ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
