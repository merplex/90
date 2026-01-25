require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// --- 1. ตรวจสอบ Environment Variables ก่อนเริ่ม ---
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ CRITICAL ERROR: Missing Supabase Config in Railway Variables");
  process.exit(1); // จบการทำงานทันทีถ้าไม่มีค่า
}

const app = express();
app.use(cors());
app.use(express.json());

// --- 2. Setup Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- 3. Health Check Route (สำคัญที่สุดสำหรับ Railway) ---
// Railway จะยิงมาที่ / เพื่อดูว่า Server ตายไหม ต้องตอบ 200 OK
app.get("/", (req, res) => {
  console.log("🟢 Health check ping received");
  res.status(200).send("Server is running OK");
});

/* =======================
   LIFF CONSUME
======================= */
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    console.log(`🟡 Consume Request: Token=${token}, User=${userId}`);

    if (!token || !userId) return res.status(400).send("Missing parameters");

    // 1. Lock QR
    const { data: qr, error: qrErr } = await supabase
      .from("qrPointToken")
      .update({ is_used: true, used_at: new Date(), used_by: userId })
      .eq("qr_token", token)
      .eq("is_used", false)
      .select("*")
      .maybeSingle();

    if (qrErr || !qr) {
      console.warn("❌ QR Invalid/Used:", token);
      return res.status(400).send("คิวอาร์นี้ถูกใช้ไปแล้ว");
    }

    // 2. Upsert Member
    const { data: member, error: memErr } = await supabase
      .from("ninetyMember")
      .upsert({ line_user_id: userId }, { onConflict: "line_user_id" })
      .select("id")
      .single();

    if (memErr) throw new Error("Member Error: " + memErr.message);

    // 3. Upsert Wallet
    const { error: walletErr } = await supabase
      .from("memberWallet")
      .upsert({ member_id: member.id }, { onConflict: "member_id" });
      
    if (walletErr) console.warn("⚠️ Wallet note:", walletErr.message);

    // 4. Add Point RPC
    const { error: rpcErr } = await supabase.rpc("add_point", {
      p_member_id: member.id,
      p_point: qr.point_get,
    });
    if (rpcErr) throw new Error("RPC Error: " + rpcErr.message);

    // 5. Get Balance
    const { data: finalWallet } = await supabase
      .from("memberWallet")
      .select("point_balance")
      .eq("member_id", member.id)
      .single();

    // 6. Notify Line
    if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
      axios.post("https://api.line.me/v2/bot/message/push", {
        to: userId,
        messages: [{
          type: "text",
          text: `🎉 ได้รับ ${qr.point_get} แต้ม\nยอดรวม: ${finalWallet?.point_balance ?? 0} แต้ม`
        }]
      }, {
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
      }).catch(err => console.error("⚠️ Line Push Fail:", err.message));
    }

    console.log("✅ Transaction Success");
    res.status(200).send(`ได้รับ ${qr.point_get} แต้มเรียบร้อยแล้ว`);

  } catch (err) {
    console.error("❌ Process Error:", err.message);
    res.status(500).send("System Error: " + err.message);
  }
});

/* =======================
   CREATE QR
======================= */
app.post("/create-qr", async (req, res) => {
  try {
    const { amount, machine_id } = req.body;
    if (!amount || !machine_id) return res.status(400).json({error: "No amount/machine_id"});

    const token = crypto.randomUUID();
    const point = Math.floor(amount / 10);
    const url = `https://liff.line.me/${process.env.LIFF_ID}?token=${token}`;

    const { error } = await supabase.from("qrPointToken").insert({
      qr_token: token,
      scan_amount: amount,
      point_get: point,
      machine_id,
      qr_url: url,
      is_used: false
    });

    if (error) throw error;
    res.json({ qr_url: url });
  } catch (err) {
    console.error("❌ Create QR Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =======================
   START SERVER
======================= */
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Handle Graceful Shutdown (Railway ส่ง SIGTERM มาเพื่อปิด)
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received. Closing server...');
  server.close(() => {
    console.log('Process terminated');
  });
});
