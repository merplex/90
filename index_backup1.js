require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors(), express.json(), express.static("public"));

const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");
let adminWaitList = new Set(); 
let ratioWaitList = new Set(); 

/* ============================================================
   1. API SYSTEM & 2. WEBHOOK & 3. HELPERS (คงเดิมตาม Boss สั่ง)
============================================================ */
app.post("/create-qr", async (req, res) => {
    try {
        const { amount, machine_id } = req.body;
        const { data: config } = await supabase.from("system_configs").select("*").eq("config_key", "exchange_ratio").maybeSingle();
        const baht_rate = config ? config.baht_val : 10;
        const point_rate = config ? config.point_val : 1;
        const point_get = Math.floor((amount / baht_rate) * point_rate); 
        const token = crypto.randomUUID();
        const { error } = await supabase.from("qrPointToken").insert({
            qr_token: token, point_get: point_get, machine_id: machine_id,
            scan_amount: amount, is_used: false, create_at: new Date().toISOString() 
        });
        if (error) throw error;
        const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}?token=${token}`;
        res.json({ success: true, qr_url: liffUrl, points: point_get, token: token });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/get-user-points", async (req, res) => {
    const { userId } = req.query;
    try {
        const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
        if (!m) return res.json({ points: 0 });
        const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).maybeSingle();
        res.json({ points: w?.point_balance || 0 });
    } catch (e) { res.status(500).json({ points: 0 }); }
});

app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    const { data: qrData } = await supabase.from("qrPointToken").select("*").eq("qr_token", token).maybeSingle();
    if (!qrData || qrData.is_used) return res.status(400).send("QR Invalid");
    await supabase.from("qrPointToken").update({ is_used: true, used_by: userId, used_at: new Date().toISOString() }).eq("qr_token", token);
    let { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
    if (!member) { member = (await supabase.from("ninetyMember").insert({ line_user_id: userId }).select().single()).data; }
    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).maybeSingle();
    const newTotal = (wallet?.point_balance || 0) + qrData.point_get;
    await supabase.from("memberWallet").upsert({ member_id: member.id, point_balance: newTotal }, { onConflict: 'member_id' });
    await sendReplyPush(userId, `✨ สะสมสำเร็จ! +${qrData.point_get} แต้ม (รวม: ${newTotal})`);
    res.send("SUCCESS");
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/liff/redeem-execute", async (req, res) => {
  try {
    let { userId, amount, machine_id } = req.query;
    if (machine_id?.includes("machine_id=")) machine_id = machine_id.split("machine_id=")[1].split("&")[0];
    const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).maybeSingle();
    if (!w || w.point_balance < amount) return res.status(400).send("แต้มไม่พอ");
    const newBalance = w.point_balance - amount;
    await supabase.from("memberWallet").update({ point_balance: newBalance }).eq("member_id", m.id);
    await supabase.from("redeemlogs").insert({ member_id: m.id, machine_id, points_redeemed: parseInt(amount), status: "pending", created_at: new Date().toISOString() });
    await sendReplyPush(userId, `✅ แลกสำเร็จ! -${amount} แต้ม (เหลือ: ${newBalance})`);
    res.send(`SUCCESS: MACHINE_${machine_id}_START`);
  } catch (err) { res.status(500).send(err.message); }
});

app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  for (let event of events) {
    const userId = event.source.userId;
    const isUserAdmin = await isAdmin(userId);
    if (event.type !== "message" || event.message.type !== "text") continue;
    const rawMsg = event.message.text.trim();
    const userMsg = rawMsg.toUpperCase();
    try {
      if (userMsg === "USER_LINE") return await sendReply(event.replyToken, `ID: ${userId}`);
      if (isUserAdmin) {
        if (ratioWaitList.has(userId)) { ratioWaitList.delete(userId); return await updateExchangeRatio(rawMsg, event.replyToken); }
        if (adminWaitList.has(userId)) { adminWaitList.delete(userId); return await addNewAdmin(rawMsg, event.replyToken); }
        if (userMsg === "ADMIN") return await sendAdminDashboard(event.replyToken);
        if (userMsg === "MANAGE_ADMIN") return await sendManageAdminFlex(event.replyToken);
        if (userMsg === "REPORT") return await sendReportMenu(event.replyToken);
        if (userMsg === "SUB_PENDING") return await listSubReport(event.replyToken, "PENDING");
        if (userMsg === "SUB_EARNS") return await listSubReport(event.replyToken, "EARNS");
        if (userMsg === "SUB_REDEEMS") return await listSubReport(event.replyToken, "REDEEMS");
        if (userMsg === "LIST_ADMIN") return await listAdminsWithDelete(event.replyToken);
        if (userMsg === "SET_RATIO_STEP1") { ratioWaitList.add(userId); return await sendReply(event.replyToken, "📊 ระบุ บาท:แต้ม (เช่น 10:1)"); }
        if (userMsg === "ADD_ADMIN_STEP1") { adminWaitList.add(userId); return await sendReply(event.replyToken, "🆔 ส่ง ID เว้นวรรคตามด้วยชื่อ"); }
        if (userMsg.startsWith("DEL_ADMIN_ID ")) return await deleteAdmin(rawMsg.split(" ")[1], event.replyToken);
        if (userMsg.startsWith("APPROVE_ID ")) return await approveSpecificPoint(rawMsg.split(" ")[1], event.replyToken);
        if (userMsg.startsWith("GET_HISTORY ")) return await sendUserHistory(rawMsg.split(" ")[1], event.replyToken);
      }
      const pointMatch = rawMsg.match(/^(\d+)\s*(แต้ม|คะแนน|p|point|pts)?$/i);
      if (pointMatch) {
          const points = parseInt(pointMatch[1]);
          if (points > 0) {
              await supabase.from("point_requests").insert({ line_user_id: userId, points: points, request_at: new Date().toISOString() });
              return await sendReply(event.replyToken, `📝 ส่งคำขอ ${points} แต้ม ให้แอดมินแล้วค่ะ`);
          }
      }
      if (userMsg === "CHECK_POINT") {
          const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).maybeSingle();
          const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member?.id).maybeSingle();
          await sendReply(event.replyToken, `🌟 ยอดแต้มของคุณ: ${w?.point_balance || 0} แต้ม`);
      }
    } catch (e) { console.error("Webhook Error:", e); }
  }
  res.sendStatus(200);
});

async function isAdmin(uid) { 
    if(!uid) return false;
    const { data } = await supabase.from("bot_admins").select("line_user_id").eq("line_user_id", uid).maybeSingle(); 
    return !!data; 
}
async function updateExchangeRatio(input, rt) {
    const parts = input.split(":");
    if (parts.length !== 2) return await sendReply(rt, "❌ รูปแบบผิด! เช่น 10:1");
    await supabase.from("system_configs").upsert({ config_key: "exchange_ratio", baht_val: parseInt(parts[0]), point_val: parseInt(parts[1]), updated_at: new Date().toISOString() }, { onConflict: 'config_key' });
    await sendReply(rt, `✅ ตั้งค่าสำเร็จ! ${parts[0]} บาท : ${parts[1]} แต้ม`);
}
async function addNewAdmin(input, rt) {
  const [tid, name] = input.split(/\s+/);
  if (!tid?.startsWith("U")) return await sendReply(rt, "❌ ID ผิดพลาด");
  await supabase.from("bot_admins").upsert({ line_user_id: tid, admin_name: name || "Admin" }, { onConflict: 'line_user_id' });
  await sendReply(rt, `✅ เพิ่มแอดมินสำเร็จ!`);
}
async function deleteAdmin(tid, rt) {
  await supabase.from("bot_admins").delete().eq("line_user_id", tid);
  await sendReply(rt, "🗑️ ลบเรียบร้อย");
}

// ✨ จุดแก้ไขที่ 2: บันทึกรายการ Approve ลงตาราง Earn Logs เพื่อให้ขึ้น Recent Earns
async function approveSpecificPoint(rid, rt) {
  const { data: req } = await supabase.from("point_requests").select("*").eq("id", rid).maybeSingle();
  if (!req) return;
  let { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", req.line_user_id).maybeSingle();
  if (!m) { m = (await supabase.from("ninetyMember").insert({ line_user_id: req.line_user_id }).select().single()).data; }
  const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).maybeSingle();
  const newTotal = (w?.point_balance || 0) + req.points;
  
  await supabase.from("memberWallet").upsert({ member_id: m.id, point_balance: newTotal }, { onConflict: 'member_id' });
  
  // ✅ FIX: บันทึกลงตาราง qrPointToken (ใช้ machine_id: "ADMIN") เพื่อให้แสดงผลใน Recent Earns และ History
  await supabase.from("qrPointToken").insert({
      qr_token: `MANUAL-${crypto.randomUUID()}`,
      point_get: req.points,
      machine_id: "ADMIN",
      is_used: true,
      used_by: req.line_user_id,
      used_at: new Date().toISOString(),
      create_at: new Date().toISOString()
  });

  await supabase.from("point_requests").delete().eq("id", req.id);
  await sendReply(rt, `✅ อนุมัติสำเร็จ!`);
  await sendReplyPush(req.line_user_id, `🎊 แอดมินอนุมัติ ${req.points} แต้มแล้วค่ะ`);
}

/* ============================================================
   4. INTERACTIVE REPORTS
============================================================ */
const formatTime = (iso) => {
    if (!iso) return "--:--";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "--:--";
    return d.getHours().toString().padStart(2, '0') + ":" + d.getMinutes().toString().padStart(2, '0');
};

const createRow = (machine, uid, pts, time, color) => ({
    type: "box", layout: "horizontal", margin: "xs", contents: [
        { type: "text", text: `[${String(machine || "?")}]`, size: "xxs", flex: 3, color: "#888888", gravity: "center" },
        { type: "text", text: String(uid || "-"), size: "xxs", flex: 6, weight: "bold", color: "#4267B2", wrap: false, gravity: "center", action: { type: "message", text: `GET_HISTORY ${uid}` } },
        { type: "text", text: String(pts), size: "xxs", flex: 3, color: color, align: "end", weight: "bold", gravity: "center" },
        { type: "text", text: formatTime(time), size: "xxs", flex: 2, align: "end", color: "#aaaaaa", gravity: "center" }
    ]
});

async function sendReportMenu(replyToken) {
  const flex = {
    type: "bubble",
    header: { type: "box", layout: "vertical", backgroundColor: "#00b900", contents: [{ type: "text", text: "📊 เลือกรายงาน (15 รายการล่าสุด)", color: "#ffffff", weight: "bold", size: "md", align: "center" }] },
    body: { type: "box", layout: "vertical", spacing: "md", contents: [
        { type: "button", style: "primary", color: "#ff4b4b", action: { type: "message", label: "🔔 Pending Requests", text: "SUB_PENDING" } },
        { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📥 Recent Earns", text: "SUB_EARNS" } },
        { type: "button", style: "primary", color: "#ff9f00", action: { type: "message", label: "📤 Recent Redeems", text: "SUB_REDEEMS" } }
    ]}
  };
  await sendFlex(replyToken, "Select Report", flex);
}

async function listSubReport(replyToken, type) {
    try {
        let title = "", color = "", rows = [];
        if (type === "PENDING") {
            title = "🔔 Pending Requests (15)"; color = "#ff4b4b";
            const { data } = await supabase.from("point_requests").select("*").order("request_at", { ascending: false });
            const uniqueMap = new Map();
            (data || []).forEach(item => {
                if (!uniqueMap.has(item.line_user_id)) uniqueMap.set(item.line_user_id, item);
            });
            const uniqueList = Array.from(uniqueMap.values()).slice(0, 15);
            rows = uniqueList.map(r => ({
                type: "box", layout: "horizontal", margin: "md", alignItems: "center",
                contents: [
                    { type: "text", text: String(r.line_user_id || "-").substring(0, 8) + "...", size: "xs", flex: 4, gravity: "center", action: { type: "message", text: `GET_HISTORY ${r.line_user_id}` } },
                    { type: "text", text: `+${r.points}p`, size: "sm", flex: 3, color: "#00b900", align: "center", weight: "bold", gravity: "center" },
                    { type: "button", style: "primary", color: "#00b900", height: "sm", flex: 3, action: { type: "message", label: "OK", text: `APPROVE_ID ${r.id}` } }
                ]
            }));
        } else if (type === "EARNS") {
            title = "📥 Recent Earns (15)"; color = "#00b900";
            const { data: earns } = await supabase.from("qrPointToken").select("*").eq("is_used", true).order("used_at", { ascending: false }).limit(15);
            rows = (earns || []).map(e => createRow(e.machine_id, e.used_by, `+${e.point_get}p`, e.used_at || e.create_at, "#00b900"));
        } else if (type === "REDEEMS") {
            title = "📤 Recent Redeems (15)"; color = "#ff9f00";
            const { data: raw } = await supabase.from("redeemlogs").select("*").order("created_at", { ascending: false }).limit(15);
            if (raw && raw.length > 0) {
                const uids = raw.map(r => r.member_id).filter(id => id);
                const { data: ms } = await supabase.from("ninetyMember").select("id, line_user_id").in("id", uids);
                const memMap = Object.fromEntries((ms || []).map(m => [m.id, m.line_user_id]));
                rows = raw.map(r => {
                    const isRefund = r.status === 'refunded';
                    return createRow(r.machine_id, memMap[r.member_id], isRefund ? `-${r.points_redeemed} (Ref)` : `-${r.points_redeemed}p`, r.created_at, isRefund ? "#aaaaaa" : "#ff4b4b");
                });
            }
        }
        if (rows.length === 0) return await sendReply(replyToken, `ℹ️ ยังไม่มีรายการในหัวข้อ ${title} ค่ะ`);
        await sendFlex(replyToken, title, { type: "bubble", header: { type: "box", layout: "vertical", backgroundColor: color, contents: [{ type: "text", text: title, color: "#ffffff", weight: "bold" }] }, body: { type: "box", layout: "vertical", spacing: "xs", contents: rows } });
    } catch (e) { await sendReply(replyToken, `❌ Error: ${e.message}`); }
}

// ✨ จุดแก้ไขที่ 1: ตัด REQUEST- (รายการรออนุมัติ) ออกจากหน้าประวัติ History
async function sendUserHistory(targetUid, rt) {
    try {
        const [earnsRes, memRes] = await Promise.all([
            // ✅ ดึงเฉพาะรายการ Earn ที่สำเร็จแล้วเท่านั้น (รวมถึงรายการที่ Admin Approve มาด้วย)
            supabase.from("qrPointToken").select("*").eq("used_by", targetUid).eq("is_used", true).order("used_at", { ascending: false }).limit(15),
            supabase.from("ninetyMember").select("id").eq("line_user_id", targetUid).maybeSingle()
        ]);
        let redeems = [];
        if (memRes.data) {
            const { data: rdm } = await supabase.from("redeemlogs").select("*").eq("member_id", memRes.data.id).order("created_at", { ascending: false }).limit(15);
            redeems = rdm || [];
        }
        let allTx = [
            // ✅ ตัด REQUEST_ ค้างไว้ออกไป ตามสั่ง
            ...(earnsRes.data || []).map(e => ({ label: `EARN${e.machine_id || '-'}`, pts: `+${e.point_get}`, time: e.used_at || e.create_at, color: "#00b900" })),
            ...(redeems || []).map(u => {
                const isRefund = u.status === 'refunded';
                return { label: `REDEEM${u.machine_id || '-'}`, pts: isRefund ? `-${u.points_redeemed} (Ref)` : `-${u.points_redeemed}`, time: u.created_at, color: isRefund ? "#aaaaaa" : "#ff4b4b" };
            })
        ];
        allTx.sort((a, b) => new Date(b.time) - new Date(a.time));
        const finalHistory = allTx.slice(0, 15);
        const flex = {
            type: "bubble",
            header: { type: "box", layout: "vertical", backgroundColor: "#333333", contents: [{ type: "text", text: `📜 HISTORY: ${targetUid}`, color: "#ffffff", weight: "bold", size: "xxs" }] },
            body: { type: "box", layout: "vertical", spacing: "sm", contents: finalHistory.map(tx => ({
                type: "box", layout: "horizontal", contents: [
                    { type: "text", text: tx.label, size: "xxs", flex: 5, color: "#555555", weight: "bold" },
                    { type: "text", text: tx.pts, size: "xs", flex: 4, weight: "bold", color: tx.color, align: "end" },
                    { type: "text", text: new Date(tx.time).toLocaleDateString('th-TH',{day:'2-digit',month:'2-digit'}) + " " + formatTime(tx.time), size: "xxs", flex: 3, align: "end", color: "#aaaaaa" }
                ]
            })) }
        };
        await sendFlex(rt, "User History", flex);
    } catch (e) { await sendReply(rt, "❌ History Error"); }
}

/* ============================================================
   5. UTILS - คงเดิม (มีแก้ไข Layout Admin List ตามล่าสุดที่คุยกัน)
============================================================ */
async function sendAdminDashboard(rt) {
  const flex = { type: "bubble", header: { type: "box", layout: "vertical", backgroundColor: "#1c1c1c", contents: [{ type: "text", text: "NINETY God Mode", color: "#00b900", weight: "bold", size: "xl" }] }, body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "button", style: "primary", color: "#333333", action: { type: "message", label: "⚙️ MANAGE ADMIN", text: "MANAGE_ADMIN" } }, { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📊 ACTIVITY REPORT", text: "REPORT" } }, { type: "button", style: "primary", color: "#ff9f00", action: { type: "message", label: "💰 SET EXCHANGE RATIO", text: "SET_RATIO_STEP1" } }] } };
  await sendFlex(rt, "God Mode", flex);
}
async function sendManageAdminFlex(rt) {
  const flex = { type: "bubble", body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "⚙️ ADMIN SETTINGS", weight: "bold", size: "lg" }, { type: "button", style: "secondary", action: { type: "message", label: "📋 LIST & REMOVE ADMIN", text: "LIST_ADMIN" } }, { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "➕ ADD NEW ADMIN", text: "ADD_ADMIN_STEP1" } }] } };
  await sendFlex(rt, "Admin Settings", flex);
}
async function listAdminsWithDelete(rt) {
  const { data: adms } = await supabase.from("bot_admins").select("*");
  const adminRows = (adms || []).map(a => ({ 
      type: "box", layout: "horizontal", margin: "md", alignItems: "center",
      contents: [
          { type: "text", text: `👤 ${a.admin_name}`, size: "sm", flex: 5, gravity: "center" }, 
          { type: "button", style: "primary", color: "#ff4b4b", height: "sm", flex: 2, action: { type: "message", label: "DEL", text: `DEL_ADMIN_ID ${a.line_user_id}` } }
      ] 
  }));
  await sendFlex(rt, "Admin List", { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "🔐 ADMIN LIST", weight: "bold", size: "lg", margin: "md" }, ...adminRows] } });
}
async function sendReply(rt, text) { try { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); } catch (e) { console.error("Reply Error:", e.response?.data); }}
async function sendReplyPush(to, text) { try { await axios.post("https://api.line.me/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); } catch (e) { console.error("Push Error:", e.response?.data); }}
async function sendFlex(rt, alt, contents) { 
  try { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "flex", altText: alt, contents }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }}); } 
  catch (err) { console.error("LINE Flex Error Details:", err.response?.data); await sendReply(rt, `❌ LINE Reject: ${err.response?.data?.message || "Unknown"}`); }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 God Mode on port ${PORT}`));
