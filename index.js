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

/* =======================
   LIFF CONSUME API
======================= */
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    console.log(`🟡 Processing User: ${userId}`);

    if (!token || !userId) return res.status(400).send("Data Incomplete");

    // 1. Lock QR
    const { data: qr, error: qrErr } = await supabase
      .from("qrPointToken")
      .update({ is_used: true, used_at: new Date(), used_by: userId })
      .eq("qr_token", token)
      .eq("is_used", false)
      .select()
      .maybeSingle();

    if (qrErr || !qr) return res.status(400).send("QR Invalid or Used");

    // 2. Manage Member
    const { data: member, error: memErr } = await supabase
      .from("ninetyMember")
      .upsert({ line_user_id: userId }, { onConflict: "line_user_id" })
      .select("id")
      .single();

    if (memErr) throw memErr;

    // 3. Manage Wallet
    await supabase
      .from("memberWallet")
      .upsert({ member_id: member.id }, { onConflict: "member_id" });

    // 4. Add Point (RPC)
    const { error: rpcErr } = await supabase.rpc("add_point", {
      p_member_id: member.id,
      p_point: qr.point_get
    });

    if (rpcErr) throw rpcErr;

    // 5. Line Notify
    if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
      axios.post("https://api.line.me/v2/bot/message/push", {
        to: userId,
        messages: [{ type: "text", text: `ได้รับ ${qr.point_get} แต้มสำเร็จ!` }]
      }, { headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } })
      .catch(e => console.error("Line Push Fail"));
    }

    res.status(200).send("Success");
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).send("Server Error");
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
    const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}?token=${token}`;

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
