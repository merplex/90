require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors()); // อนุญาตให้ LIFF เรียก API ได้
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Health Check สำหรับ Railway
app.get("/", (req, res) => res.status(200).send("Server is running"));

/* =======================
   LIFF CONSUME (รับแต้ม)
======================= */
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    console.log(`🟡 Processing: Token=${token}, User=${userId}`);

    if (!token || !userId) return res.status(400).send("ข้อมูลไม่ครบถ้วน");

    // 1. ตรวจสอบและ Lock QR ทันที (ป้องกันสแกนซ้ำ)
    const { data: qr, error: qrErr } = await supabase
      .from("qrPointToken")
      .update({ is_used: true, used_at: new Date(), used_by: userId })
      .eq("qr_token", token)
      .eq("is_used", false)
      .select("*")
      .maybeSingle();

    if (qrErr || !qr) {
      console.error("❌ QR Error:", qrErr);
      return res.status(400).send("QR นี้ถูกใช้งานแล้ว หรือรหัสไม่ถูกต้อง");
    }

    // 2. ลงทะเบียน/ดึงข้อมูลสมาชิก
    const { data: member, error: memErr } = await supabase
      .from("ninetyMember")
      .upsert({ line_user_id: userId }, { onConflict: "line_user_id" })
      .select("id")
      .single();

    if (memErr) throw memErr;

    // 3. ตรวจสอบ/สร้าง Wallet (ใช้ upsert เพื่อป้องกัน Error ถ้ามีอยู่แล้ว)
    const { error: walletErr } = await supabase
      .from("memberWallet")
      .upsert({ member_id: member.id }, { onConflict: "member_id" });

    if (walletErr) console.warn("Wallet Upsert Warning:", walletErr.message);

    // 4. บันทึกแต้ม (เรียก RPC add_point ที่คุณต้องสร้างใน SQL Editor)
    const { error: rpcErr } = await supabase.rpc("add_point", {
      p_member_id: member.id,
      p_point: qr.point_get,
    });
    if (rpcErr) throw rpcErr;

    // 5. ดึงยอดแต้มล่าสุด
    const { data: balance } = await supabase
      .from("memberWallet")
      .select("point_balance")
      .eq("member_id", member.id)
      .single();

    // 6. แจ้งเตือนผ่าน LINE OA (ถ้ามี Token)
    if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
      await axios.post("https://api.line.me/v2/bot/message/push", {
        to: userId,
        messages: [{
          type: "text",
          text: `🎉 รับแต้มสำเร็จ!\nได้รับ ${qr.point_get} แต้ม\nยอดสะสมทั้งหมด: ${balance?.point_balance || 0} แต้ม`
        }]
      }, {
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
      }).catch(e => console.error("LINE Push Failed"));
    }

    res.status(200).send("บันทึกแต้มสำเร็จแล้ว!");

  } catch (err) {
    console.error("❌ Server Error:", err.message);
    res.status(500).send("เกิดข้อผิดพลาดภายในระบบ: " + err.message);
  }
});

/* =======================
   CREATE QR (จากเครื่อง HMI)
======================= */
app.post("/create-qr", async (req, res) => {
  try {
    const { amount, machine_id } = req.body;
    const token = crypto.randomUUID();
    const point = Math.floor(amount / 10);
    const qrUrl = `https://liff.line.me/${process.env.LIFF_ID}?token=${token}`;

    const { error } = await supabase.from("qrPointToken").insert({
      qr_token: token,
      scan_amount: amount,
      point_get: point,
      is_used: false,
      machine_id,
      qr_url: qrUrl
    });

    if (error) throw error;
    res.json({ qr_url: qrUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("🚀 Server standby on port", PORT));
