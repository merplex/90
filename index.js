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

    // 2. ตรวจสอบสมาชิก (ถ้าไม่เจอให้สร้างใหม่เลย)
    let { data: memberData } = await supabase
      .from("ninetyMember")
      .select("id")
      .eq("line_user_id", userId)
      .single();

    if (!memberData) {
    // ✨ ถ้าไม่พบสมาชิก ให้ Insert ลงไปใหม่ทันที
    const { data: newMember, error: insertError } = await supabase
      .from("ninetyMember")
      .insert({ line_user_id: userId })
      .select()
      .single();
    
    if (insertError) throw new Error("สร้างสมาชิกใหม่ไม่สำเร็จ");
    memberData = newMember;
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
   WEBHOOK: รวมระบบคุยธรรมชาติ + ระบบเดิม 🤖
==================================== */
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  
  for (let event of events) {
    const userId = event.source.userId;
    const ADMIN_IDS = ["U8d1d21082843a3aedb6cdd65f8779454", "Ud739afa32a9004fd318892feab424598"]; 

    if (event.type === "message" && event.message.type === "text") {
      // จัดการข้อความ: ตัดช่องว่างหน้าหลัง และแปลงเป็นตัวพิมพ์ใหญ่
      const rawMsg = event.message.text.trim();
      const userMsg = rawMsg.toUpperCase(); 

      try {
        // ====================================================
        // 🟢 ส่วนที่ 1: ระบบคุยธรรมชาติ (ขอแต้ม / อนุมัติ)
        // ====================================================

        // 1.1 ลูกค้าพิมพ์: "xxแต้ม" (เช่น 20แต้ม, 50แต้ม)
        if (rawMsg.match(/^\d+\s*แต้ม$/)) { 
          const pointsRequest = parseInt(rawMsg.replace("แต้ม", "").trim());
          
          if (pointsRequest > 0) {
            // ลบคำขอเก่า -> สร้างคำขอใหม่
            await supabase.from("point_requests").delete().eq("line_user_id", userId);
            await supabase.from("point_requests").insert({
              line_user_id: userId,
              points: pointsRequest,
              request_at: new Date().toISOString()
            });
            console.log(`📝 User ${userId} ขอมา ${pointsRequest} แต้ม`);
          }
        }

        // 1.2 แอดมินพิมพ์: "OK" (ภายใน 1 นาที)
        else if ((userMsg === "OK" || userMsg === "โอเค") && ADMIN_IDS.includes(userId)) {
          const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
          
          // หาคำขอล่าสุด
          const { data: request } = await supabase.from("point_requests").select("*")
            .gt("request_at", oneMinuteAgo).order("request_at", { ascending: false }).limit(1).single();

          if (request) {
            // เรียกฟังก์ชันเติมแต้ม (ต้องมีฟังก์ชัน addPointToUser ท้ายไฟล์นะ!)
            await addPointToUser(request.line_user_id, request.points, event.replyToken);
            // ลบคำขอทิ้ง
            await supabase.from("point_requests").delete().eq("id", request.id);
          }
        }

        // ====================================================
        // 🔵 ส่วนที่ 2: ระบบเดิมของเปรม (CHECK, REDEEM, REFUND)
        // ====================================================
        else {
            // ค้นหาสมาชิกก่อน (ถ้าไม่ใช่คำสั่งข้างบน ค่อยมาเช็กตรงนี้)
            const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
            
            // ถ้าเป็นสมาชิก ให้ทำงานต่อ
            if (member) {

                // --- 2.1 เช็กแต้ม ---
                if (userMsg === "CHECK_POINT") {
                    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
                    await sendReply(event.replyToken, `🌟 คุณมีแต้มสะสม: ${wallet?.point_balance || 0} แต้ม`);
                } 
                
                // --- 2.2 ใช้แต้ม (REDEEM) ---
                else if (userMsg.startsWith("REDEEM_")) {
                    const amount = parseInt(userMsg.split("_")[1]);
                    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
                    
                    if ((wallet?.point_balance || 0) < amount) {
                        await sendReply(event.replyToken, `❌ แต้มไม่พอค่ะ (มี ${wallet?.point_balance || 0} ใช้ ${amount})`);
                    } else {
                        await sendScanRequest(event.replyToken, amount);
                    }
                }

                // --- 2.3 คืนแต้ม (REFUND) - ตามโค้ดเดิมเป๊ะๆ ---
                else if (userMsg === "REFUND") {
                    console.log(`💰 [REFUND] เริ่มตรวจสอบรายการคืนแต้มสำหรับ User: ${userId}`);
            
                    try {
                        // ค้นหารายการ pending
                        const { data: lastLog, error: logError } = await supabase.from("redeemlogs").select("*")
                            .eq("member_id", member.id).eq("status", 'pending')
                            .order("created_at", { ascending: false }).limit(1).single();

                        if (logError || !lastLog) {
                            console.log("❌ [REFUND] ไม่พบรายการที่คืนได้");
                            await sendReply(event.replyToken, "❌ ไม่พบรายการที่ค้างอยู่ค่ะ\n(รายการล่าสุดอาจจะทำงานสำเร็จไปแล้ว หรือยังไม่มีการหักแต้มเข้ามา)");
                        } else {
                            // คืนแต้ม
                            const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
                            const currentBalance = wallet ? (wallet.point_balance || 0) : 0;
                            const newTotal = currentBalance + lastLog.points_redeemed;

                            await supabase.from("memberWallet").update({ point_balance: newTotal }).eq("member_id", member.id);
                            await supabase.from("redeemlogs").update({ status: 'refunded', is_refunded: true }).eq("id", lastLog.id);

                            console.log(`✅ [REFUND] คืนแต้มสำเร็จ: ${lastLog.points_redeemed} pts`);
                            await sendReply(event.replyToken, `💰 ระบบคืนแต้มให้แล้วค่ะ!\n\n+ คืนให้: ${lastLog.points_redeemed} แต้ม\n🌟 ยอดรวมปัจจุบัน: ${newTotal} แต้ม`);
                        }
                    } catch (err) {
                        console.error("💀 [REFUND ERROR]:", err.message);
                        await sendReply(event.replyToken, "⚠️ เกิดข้อผิดพลาดในระบบคืนแต้ม กรุณาลองใหม่ภายหลังค่ะ");
                    }
                } 
            } // ปิด if (member)
        } // ปิด else (ส่วนที่ 2)

      } catch (e) { console.error("💀 Webhook Error:", e.message); }
    } // ปิด if text message
  } // ปิด for loop
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
   ฟังก์ชันเติมแต้ม (Add Point to User) 💰
   ใช้สำหรับระบบ "ขอแต้ม -> แอดมินตอบ OK"
==================================== */
async function addPointToUser(targetUid, pts, replyToken) {
  try {
    console.log(`🎯 เริ่มกระบวนการเติมแต้มให้: ${targetUid} จำนวน ${pts} แต้ม`);
    
    // 1. ค้นหาข้อมูลสมาชิกจาก line_user_id
    const { data: member, error: mErr } = await supabase
      .from("ninetyMember")
      .select("id")
      .eq("line_user_id", targetUid)
      .single();

    if (mErr || !member) {
      console.error("❌ ไม่พบสมาชิกรายนี้ในระบบค่ะ:", mErr?.message);
      if (replyToken) await sendReply(replyToken, "❌ ไม่พบข้อมูลสมาชิกรายนี้ในระบบค่ะ");
      return;
    }

    // 2. ดึงยอดแต้มปัจจุบันจากกระเป๋าเงิน (memberWallet)
    const { data: wallet, error: wErr } = await supabase
      .from("memberWallet")
      .select("point_balance")
      .eq("member_id", member.id)
      .single();

    // ถ้ายังไม่มีกระเป๋าเงิน ให้เริ่มที่ 0 ค่ะ
    const currentBalance = wallet ? (wallet.point_balance || 0) : 0;
    const newTotal = currentBalance + pts;

    // 3. อัปเดตยอดแต้มใหม่ลงฐานข้อมูล (ใช้ upsert เผื่อกรณีลูกค้ายังไม่มีแถวใน wallet)
    const { error: upErr } = await supabase
      .from("memberWallet")
      .upsert({ 
        member_id: member.id, 
        point_balance: newTotal 
      }, { onConflict: 'member_id' });

    if (upErr) throw upErr;

    // 4. ส่งข้อความยืนยันแจ้งทั้งแอดมินและลูกค้าค่ะ
    // แจ้งแอดมิน (ผ่าน Reply)
    if (replyToken) {
      await sendReply(replyToken, `✅ อนุมัติเรียบร้อยค่ะ!\nเติมให้: ${pts} แต้ม\n🌟 ยอดรวมลูกค้าตอนนี้: ${newTotal} แต้มค่ะ`);
    }
    
    // แจ้งลูกค้า (ผ่าน Push Message)
    await sendReplyPush(targetUid, `🎊 แอดมินได้เติมแต้มพิเศษให้คุณ ${pts} แต้มเรียบร้อยแล้วค่ะ!\n🌟 ยอดรวมปัจจุบันของคุณคือ: ${newTotal} แต้ม ✨`);

    console.log(`✅ เติมแต้มให้ ${targetUid} สำเร็จแล้วค่ะ!`);

  } catch (err) {
    console.error("💀 เกิดข้อผิดพลาดในฟังก์ชัน addPointToUser:", err.message);
    if (replyToken) await sendReply(replyToken, "⚠️ เกิดข้อผิดพลาดระหว่างเติมแต้ม กรุณาลองใหม่นะคะ");
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