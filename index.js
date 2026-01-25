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

const cors = require("cors");

app.use(cors());
app.use(express.json());

/* =======================
   INIT
======================= */
const app = express();
app.use(cors()); // 👈 สำคัญมาก แก้ Failed to fetch
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =======================
   LINE PUSH
======================= */
async function pushPointMessage(userId, pointGet, totalPoint) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: userId,
      messages: [
        {
          type: "text",
          text:
`🎉 สะสมแต้มสำเร็จ
ได้รับ ${pointGet} แต้ม
แต้มสะสมทั้งหมด: ${totalPoint} แต้ม`
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
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
  const { token, userId } = req.query;
  console.log("🔥 CONSUME:", token, userId);

  if (!token || !userId) {
    return res.send("invalid request");
  }

  /* 1. LOCK QR */
  const { data: qr, error: qrErr } = await supabase
    .from("qrPointToken")
    .update({
      is_used: true,
      used_at: new Date(),
      used_by: userId
    })
    .eq("qr_token", token)
    .eq("is_used", false)
    .select("*")
    .maybeSingle();

  if (qrErr || !qr) {
    return res.send("QR ถูกใช้แล้ว หรือไม่ถูกต้อง");
  }

  if (new Date(qr.expired_at) < new Date()) {
    return res.send("QR หมดอายุ");
  }

  /* 2. ensure member */
  const { data: member } = await supabase
    .from("ninetyMember")
    .upsert(
      { line_user_id: userId },
      { onConflict: "line_user_id" }
    )
    .select("id")
    .single();

  /* 3. ensure wallet */
  const { data: wallet } = await supabase
    .from("memberWallet")
    .select("point_balance")
    .eq("member_id", member.id)
    .maybeSingle();

  if (!wallet) {
    await supabase.from("memberWallet").insert({
      member_id: member.id,
      point_balance: 0
    });
  }

  /* 4. เพิ่มแต้ม */
  const { error: addErr } = await supabase.rpc("add_point", {
    p_member_id: member.id,
    p_point: qr.point_get
  });

  if (addErr) {
    console.error(addErr);
    return res.send("เพิ่มแต้มไม่สำเร็จ");
  }

  /* 5. อ่านแต้มล่าสุด */
  const { data: walletAfter } = await supabase
    .from("memberWallet")
    .select("point_balance")
    .eq("member_id", member.id)
    .single();

  /* 6. PUSH LINE */
  await pushPointMessage(
    userId,
    qr.point_get,
    walletAfter.point_balance
  );

  /* 7. ตอบหน้า LIFF (ไม่สำคัญ) */
  res.send("รับแต้มสำเร็จ กรุณากลับไปที่ LINE");
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

  await supabase.from("qrPointToken").insert({
    qr_token: token,
    scan_amount: amount,
    point_get: point,
    is_used: false,
    machine_id,
    qr_url: qrUrl,
    expired_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  });

  res.json({ qr_url: qrUrl });
});

/* =======================
   START SERVER
======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
});