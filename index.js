require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

/* =======================
   MIDDLEWARE (ต้องอยู่บนสุด)
======================= */
app.use(cors());
app.use(express.json());

/* =======================
   HEALTH CHECK (Railway ใช้จริง)
======================= */
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

/* =======================
   SUPABASE
======================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =======================
   LINE WEBHOOK (กัน LINE error)
======================= */
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
});

/* =======================
   LIFF CONSUME (รับแต้ม)
======================= */
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    console.log("🔥 CONSUME", token, userId);

    if (!token || !userId) {
      return res.status(400).send("invalid request");
    }

    // 🔒 lock QR
    const { data: qr } = await supabase
      .from("qrPointToken")
      .update({
        is_used: true,
        used_at: new Date(),
        used_by: userId,
      })
      .eq("qr_token", token)
      .eq("is_used", false)
      .select("*")
      .maybeSingle();

    if (!qr) {
      return res.status(400).send("QR used or invalid");
    }

    // ensure member
    const { data: member } = await supabase
      .from("ninetyMember")
      .upsert({ line_user_id: userId }, { onConflict: "line_user_id" })
      .select("*")
      .single();

    // ensure wallet
    const { data: wallet } = await supabase
      .from("memberWallet")
      .select("*")
      .eq("member_id", member.id)
      .maybeSingle();

    if (!wallet) {
      await supabase.from("memberWallet").insert({
        member_id: member.id,
        point_balance: 0,
      });
    }

    // add point
    await supabase.rpc("add_point", {
      p_member_id: member.id,
      p_point: qr.point_get,
    });

    // read new balance
    const { data: newWallet } = await supabase
      .from("memberWallet")
      .select("point_balance")
      .eq("member_id", member.id)
      .single();

    // push LINE
    await axios.post(
      "https://api.line.me/v2/bot/message/push",
      {
        to: userId,
        messages: [
          {
            type: "text",
            text: `🎉 รับแต้มสำเร็จ\nได้รับ ${qr.point_get} แต้ม\nแต้มสะสมทั้งหมด ${newWallet.point_balance} แต้ม`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ CONSUME ERROR", err);
    res.status(500).send("server error");
  }
});

/* =======================
   CREATE QR (HMI)
======================= */
app.post("/create-qr", async (req, res) => {
  const { amount, machine_id } = req.body;

  if (!amount || !machine_id) {
    return res.status(400).json({ error: "invalid input" });
  }

  const token = crypto.randomUUID();
  const point = Math.floor(amount / 10);

  await supabase.from("qrPointToken").insert({
    qr_token: token,
    scan_amount: amount,
    point_get: point,
    is_used: false,
    machine_id,
    expired_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  res.json({
    qr_url: `https://liff.line.me/${process.env.LIFF_ID}?token=${token}`,
  });
});

/* =======================
   START SERVER (Railway-safe)
======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on", PORT);
});