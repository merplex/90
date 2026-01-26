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
app.get("/", (req, res) => {
  console.log("🟢 Health Check: Railway is checking me!");
  res.status(200).send("I am alive and ready!");
});

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


// --- Start Server ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
