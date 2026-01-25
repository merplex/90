require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

/* =======================
   GLOBAL ERROR GUARD (สำคัญมาก)
======================= */
process.on("unhandledRejection", (err) => {
  console.error("❌ UNHANDLED REJECTION", err);
});
process.on("uncaughtException", (err) => {
  console.error("❌ UNCAUGHT EXCEPTION", err);
});

/* =======================
   INIT APP
======================= */
const app = express();
app.use(cors());
app.use(express.json());

/* =======================
   SUPABASE
======================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =======================
   HEALTH CHECK (Railway ต้องมี)
======================= */
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

/* =======================
   LINE WEBHOOK (ยังต้องมี)
======================= */
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
});

/* =======================
   LIFF CONSUME (รับแต้มจาก QR)
======================= */
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    console.log("🔥 LIFF CONSUME", token, userId);

    if (!token || !userId) {
      return res.status(400).send("invalid request");
    }

    /* 1. LOCK QR */
    const { data: qr, error: qrErr } = await supabase
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

    if (qrErr || !qr) {
      return res.status(400).send("QR used or invalid");
    }

    /* 2. ENSURE MEMBER */
    const { data: member, error: memberErr } = await supabase
      .from("ninetyMember")
      .upsert({ line_user_id: userId }, { onConflict: "line_user_id" })
      .select("*")
      .single();

    if (memberErr || !member) {
      return res.status(500).send("member error");
    }

    /* 3. ENSURE WALLET */
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

    /* 4. ADD POINT */
    await supabase.rpc("add_point", {
      p_member_id: member.id,
      p_point: qr.point_get,
    });

    /* 5. READ NEW BALANCE */
    const { data: newWallet } = await supabase
      .from("memberWallet")
      .select("point_balance")
      .eq("member_id", member.id)
      .single();

    /* 6. PUSH LINE (ไม่พังถ้า token ผิด) */
    if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
      try {
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
      } catch (lineErr) {
        console.error("⚠️ LINE PUSH FAIL", lineErr.response?.data || lineErr.message);
      }
    } else {
      console.warn("⚠️ LINE_CHANNEL_ACCESS_TOKEN missing");
    }

    res.send("OK");
  } catch (err) {
    console.error("❌ LIFF CONSUME ERROR", err);
    res.status(500).send("server error");
  }
});

/* =======================
   CREATE QR (HMI)
======================= */
app.post("/create-qr", async (req, res) => {
  try {
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
  } catch (err) {
    console.error("❌ CREATE QR ERROR", err);
    res.status(500).json({ error: "server error" });
  }
});

/* =======================
   START SERVER (ต้องมี)
======================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on", PORT);
});