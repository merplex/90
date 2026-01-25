require("dotenv").config();

/* =======================
   1. IMPORT
======================= */
const express = require("express");
const path = require("path");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

/* =======================
   2. INIT
======================= */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =======================
   3. UTIL
======================= */
async function pushPointMessage(userId, pointGet, newPoint) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: userId,
      messages: [
        {
          type: "text",
          text: `🎉 สะสมแต้มสำเร็จ
ได้รับ ${pointGet} แต้ม
แต้มสะสมทั้งหมด: ${newPoint} แต้ม`,
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
async function replyText(replyToken, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [
        {
          type: "text",
          text,
        },
      ],
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );
}

/* =======================
   4. WEBHOOK (LINE)
======================= */
app.post("/webhook", async (req, res) => {
  const events = req.body.events;

  console.log("📩 WEBHOOK HIT:", JSON.stringify(req.body));

  if (!events || events.length === 0) {
    return res.sendStatus(200);
  }

  for (const event of events) {
    try {
      await handleLineEvent(event);
    } catch (err) {
      console.error("❌ handleLineEvent error:", err);
    }
  }

  res.sendStatus(200);
});

/* =======================
   HANDLE EVENT
======================= */
async function handleLineEvent(event) {
  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  const text = event.message.text.trim();
  const userId = event.source.userId;

  console.log("💬 MESSAGE:", text, "FROM:", userId);

  /* ===== CHECK POINT ===== */
  if (text === "CHECK_POINT") {
    // 1. หา member
    const { data: member, error: memberErr } = await supabase
      .from("ninetyMember")
      .select("id")
      .eq("line_user_id", userId)
      .single();

    if (memberErr || !member) {
      await replyText(event.replyToken, "❌ ยังไม่พบข้อมูลสมาชิก");
      return;
    }

    // 2. อ่าน wallet
    const { data: wallet, error: walletErr } = await supabase
      .from("memberWallet")
      .select("point_balance")
      .eq("member_id", member.id)
      .single();

    if (walletErr) {
      console.error(walletErr);
      await replyText(event.replyToken, "❌ อ่านข้อมูลแต้มไม่สำเร็จ");
      return;
    }

    const point = wallet?.point_balance ?? 0;

    // 3. ตอบกลับ LINE
    await replyText(
      event.replyToken,
      `🎉 แต้มสะสมของคุณ\nแต้มสะสมทั้งหมด: ${point} แต้ม`
    );
  }
}

/* =======================
   5. LIFF CONSUME
======================= */
app.get("/liff/consume", async (req, res) => {
  const { token, userId } = req.query;

  console.log("🔥 LIFF CONSUME HIT", { token, userId });

  if (!token || !userId) {
    return res.send("❌ ข้อมูลไม่ครบ");
  }

  /* 1. 🔒 LOCK QR (ต้องมาก่อน) */
  const { data: lockedQr, error: lockError } = await supabase
    .from("qrPointToken")
    .update({
      is_used: true,
      used_at: new Date(),
      used_by: userId, // ✅ TEXT
    })
    .eq("qr_token", token)
    .eq("is_used", false)
    .select("*")
    .maybeSingle();

  if (lockError || !lockedQr) {
    console.error("LOCK QR ERROR", lockError);
    return res.send("❌ QR นี้ถูกใช้ไปแล้ว");
  }

  if (new Date(lockedQr.expired_at) < new Date()) {
    return res.send("❌ QR หมดอายุแล้ว");
  }

  /* 2. ensure member */
  const { data: member, error: memberError } = await supabase
    .from("ninetyMember")
    .upsert(
      { line_user_id: userId },
      { onConflict: "line_user_id" }
    )
    .select("*")
    .single();

  if (memberError || !member) {
    console.error(memberError);
    return res.send("❌ สร้างสมาชิกไม่สำเร็จ");
  }

  /* 3. ensure wallet */
  const { data: walletExists } = await supabase
    .from("memberWallet")
    .select("*")
    .eq("member_id", member.id)
    .maybeSingle();

  if (!walletExists) {
    const { error } = await supabase.from("memberWallet").insert({
      member_id: member.id,
      point_balance: 0,
    });
    if (error) {
      console.error(error);
      return res.send("❌ สร้างกระเป๋าแต้มไม่สำเร็จ");
    }
  }

  /* 4. เพิ่มแต้ม (DB เป็นคนบวก) */
  const { error: addPointError } = await supabase.rpc("add_point", {
    p_member_id: member.id,
    p_point: lockedQr.point_get,
  });

  if (addPointError) {
    console.error(addPointError);
    return res.send("❌ เพิ่มแต้มไม่สำเร็จ");
  }

  /* 5. อ่านแต้มล่าสุด */
  const { data: wallet } = await supabase
    .from("memberWallet")
    .select("point_balance")
    .eq("member_id", member.id)
    .single();

  const newPoint = wallet.point_balance;

  /* 6. ส่ง LINE */
  try {
    await pushPointMessage(userId, lockedQr.point_get, newPoint);
  } catch (e) {
    console.error("LINE push fail", e.message);
  }

  /* 7. LIFF RESULT */
  res.send(`
    <h2>🎉 สะสมแต้มสำเร็จ</h2>
    <p>ได้รับ ${lockedQr.point_get} แต้ม</p>
    <b>แต้มสะสมทั้งหมด: ${newPoint} แต้ม</b>
  `);
});

app.get("/redeem", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "redeem.html"));
});

/* =======================
   6. CREATE QR
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
    success: true,
    qr_token: token,
    qr_url: qrUrl,
    amount,
    point,
  });
});

/* =======================
   6.5 GET BALANCE ดึงแต้ม 👈 เพิ่มตรงนี้
======================= */
app.get("/api/balance", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "missing userId" });
  }

  // หา member
  const { data: member, error: memberErr } = await supabase
    .from("ninetyMember")
    .select("id")
    .eq("line_user_id", userId)
    .single();

  if (memberErr || !member) {
    return res.json({ balance: 0 });
  }

  // อ่าน wallet
  const { data: wallet } = await supabase
    .from("memberWallet")
    .select("point_balance")
    .eq("member_id", member.id)
    .single();

  return res.json({
    balance: wallet?.point_balance ?? 0,
  });
});
/* =======================
   แทรก REDEEM LOGIC ที่นี่
======================= */

app.post("/api/redeem", async (req, res) => {
  const { line_user_id, nonce } = req.body;

  if (!line_user_id || !nonce) {
    return res.status(400).json({ error: "invalid input" });
  }

  try {
    /* =========================
       1. หา member
       ========================= */
    const { data: member, error: memberErr } = await supabase
      .from("ninetyMember")
      .select("id")
      .eq("line_user_id", line_user_id)
      .single();

    if (memberErr || !member) {
      return res.status(404).json({ error: "member not found" });
    }

    const memberId = member.id;

    /* =========================
       2. 🔒 LOCK redeem_nonce
       ========================= */
    const { data: nonceRow, error: nonceErr } = await supabase
      .from("redeem_nonce")
      .update({
        is_used: true,
        used_at: new Date()
      })
      .eq("nonce", nonce)
      .eq("is_used", false)
      .select("*")
      .maybeSingle();

    if (nonceErr || !nonceRow) {
      return res.status(400).json({ error: "qr already used or invalid" });
    }

    if (new Date(nonceRow.expire_at) < new Date()) {
      return res.status(400).json({ error: "qr expired" });
    }

    /* =========================
       3. อ่าน wallet
       ========================= */
    const { data: wallet, error: walletErr } = await supabase
      .from("memberWallet")
      .select("point_balance")
      .eq("member_id", memberId)
      .single();

    if (walletErr || !wallet) {
      return res.status(400).json({ error: "wallet not found" });
    }

    // 👉 policy: 1 แต้ม = 1 บาท
    const usePoint = nonceRow.amount;

    if (wallet.point_balance < usePoint) {
      return res.status(400).json({ error: "point not enough" });
    }

    /* =========================
       4. หักแต้ม
       ========================= */
    const newBalance = wallet.point_balance - usePoint;

    const { error: updateErr } = await supabase
      .from("memberWallet")
      .update({ point_balance: newBalance })
      .eq("member_id", memberId);

    if (updateErr) throw updateErr;

    /* =========================
       5. log redeemTransaction
       ========================= */
    await supabase
      .from("redeemTransaction")
      .insert({
        member_id: memberId,
        machine_id: nonceRow.machine_id,
        point_used: usePoint,
        money_amount: nonceRow.amount,
        nonce: nonce,
        status: "used"
      });

    /* =========================
       6. response
       ========================= */
    return res.json({
      success: true,
      used: usePoint,
      balance: newBalance,
      machine_id: nonceRow.machine_id,
      amount: nonceRow.amount
    });

  } catch (err) {
    console.error("REDEEM ERROR:", err);
    return res.status(500).json({ error: "server error" });
  }
});

/* =======================
   7. START SERVER
======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on port", PORT);
});