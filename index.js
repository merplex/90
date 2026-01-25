require("dotenv").config();

/* =======================
   IMPORT
======================= */
const express = require("express");
const path = require("path");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

/* =======================
   INIT
======================= */
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =======================
   LINE PUSH
======================= */
async function pushPointMessage(userId, pointGet, newPoint) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: userId,
      messages: [
        {
          type: "text",
          text: `🎉 สะสมแต้มสำเร็จ\nได้รับ ${pointGet} แต้ม\nแต้มสะสมทั้งหมด: ${newPoint} แต้ม`,
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
}

/* =======================
   WEBHOOK (กัน LINE error)
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
    console.log("🔥 CONSUME:", token, userId);

    if (!token || !userId) {
      return res.status(400).send("invalid request");
    }

    /* 1. lock QR */
    const { data: qr, error: lockErr } = await supabase
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

    if (lockErr || !qr) {
      return res.status(400).send("QR used or invalid");
    }

    /* 2. ensure member */
    const { data: member, error: memberErr } = await supabase
      .from("ninetyMember")
      .upsert({ line_user_id: userId }, { onConflict: "line_user_id" })
      .select("*")
      .single();

    if (memberErr) throw memberErr;

    /* 3. ensure wallet */
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

    /* 4. add point (RPC) */
    const { error: addErr } = await supabase.rpc("add_point", {
      p_member_id: member.id,
      p_point: qr.point_get,
    });

    if (addErr) throw addErr;

    /* 5. read new balance */
    const { data: newWallet } = await supabase
      .from("memberWallet")
      .select("point_balance")
      .eq("member_id", member.id)
      .single();

    /* 6. push LINE */
    await pushPointMessage(
      userId,
      qr.point_get,
      newWallet.point_balance
    );

    /* 7. response (LIFF จะปิดเอง) */
    res.send("OK");
  } catch (err) {
    console.error("❌ CONSUME ERROR:", err);
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

  const point = Math.floor(amount / 10);
  const token = crypto.randomUUID();
  const qrUrl = `https://liff.line.me/${process.env.LIFF_ID}?token=${token}`;

  const { error } = await supabase.from("qrPointToken").insert({
    qr_token: token,
    scan_amount: amount,
    point_get: point,
    is_used: false,
    machine_id,
    qr_url: qrUrl,
    expired_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({
    qr_url: qrUrl,
    amount,
    point,
  });
});

/* =======================
   START SERVER (Railway)
======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on", PORT);
});