require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const PDFDocument = require('pdfkit'); 
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

// --- [แทรก] ตัวแปรเก็บรูปภาพชั่วคราว ---
let lastImageId = null;

/* ====================================
   1. POINT SYSTEM API
==================================== */
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    const { data: qrData } = await supabase.from("qrPointToken").select("*").eq("qr_token", token).single();
    if (!qrData || qrData.is_used) return res.status(400).send("QR ใช้ไม่ได้แล้วค่ะ");
    await supabase.from("qrPointToken").update({ is_used: true, used_by: userId, used_at: new Date().toISOString() }).eq("qr_token", token);
    let { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
    if (!member) {
      const { data: newM } = await supabase.from("ninetyMember").insert({ line_user_id: userId }).select().single();
      member = newM;
    }
    const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
    const newTotal = (wallet?.point_balance || 0) + qrData.point_get;
    await supabase.from("memberWallet").upsert({ member_id: member.id, point_balance: newTotal }, { onConflict: 'member_id' });
    await sendReplyPush(userId, `สะสมสำเร็จ! +${qrData.point_get} แต้ม (รวม: ${newTotal})`);
    res.send("SUCCESS");
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/api/get-user-points", async (req, res) => {
    const { userId } = req.query;
    try {
        const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
        if (!m) return res.json({ points: 0 });
        const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
        res.json({ points: w?.point_balance || 0 });
    } catch (e) { res.status(500).send(e.message); }
});

/* ====================================
   2. REDEEM API
==================================== */
app.get("/liff/redeem-execute", async (req, res) => {
  try {
    let { userId, amount, machine_id } = req.query;
    if (machine_id && machine_id.includes("machine_id=")) {
        machine_id = machine_id.split("machine_id=")[1].split("&")[0];
    }
    const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
    const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
    if (w.point_balance < amount) return res.status(400).send("แต้มไม่พอ");
    const newBalance = w.point_balance - amount;
    await supabase.from("memberWallet").update({ point_balance: newBalance }).eq("member_id", m.id);
    await supabase.from("redeemlogs").insert({ member_id: m.id, machine_id, points_redeemed: parseInt(amount), status: "pending" });
    await sendReplyPush(userId, `✅ ใช้แต้มสำเร็จ!\nหัก: ${amount} แต้ม\nเครื่อง: ${machine_id}\nคงเหลือ: ${newBalance} แต้ม`);
    res.send(`SUCCESS: MACHINE_${machine_id}_START`);
  } catch (err) { res.status(500).send(err.message); }
});

/* ====================================
   3. REPORT & PDF API
==================================== */
app.get("/api/report-pdf", async (req, res) => {
    const { userId, adminId } = req.query;
    if (!(await isAdmin(adminId))) return res.status(403).send("No Access");
    try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: earns } = await supabase.from("qrPointToken").select("*").eq("used_by", userId).gte("used_at", sevenDaysAgo);
        const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
        const { data: uses } = await supabase.from("redeemlogs").select("*").eq("member_id", m.id).gte("created_at", sevenDaysAgo);
        const doc = new PDFDocument({ margin: 30 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Report.pdf`);
        doc.pipe(res);
        doc.fontSize(20).text('NINETY WASH - Weekly Report', { align: 'center' });
        doc.fontSize(10).text(`User ID: ${userId}`, { align: 'center' }).moveDown();
        doc.fontSize(14).fillColor('#00b900').text('1. รายการสะสมแต้ม');
        earns.forEach(l => doc.fillColor('black').fontSize(9).text(`${new Date(l.used_at).toLocaleDateString('th')} | เครื่อง: ${l.machine_id} | +${l.point_get} pts`));
        doc.moveDown().fontSize(14).fillColor('#ff4b4b').text('2. รายการใช้แต้ม');
        uses.forEach(u => doc.fillColor('black').fontSize(9).text(`${new Date(u.created_at).toLocaleDateString('th')} | เครื่อง: ${u.machine_id} | -${u.points_redeemed} pts [${u.status}]`));
        doc.end();
    } catch (e) { res.status(500).send(e.message); }
});

/* ====================================
   4. WEBHOOK (ADMIN & USER)
==================================== */
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  for (let event of events) {
    const userId = event.source.userId;
    const isUserAdmin = await isAdmin(userId);

    // --- [แทรก] ส่วนรับรูปภาพจากไลน์ ---
    if (event.type === "message" && event.message.type === "image" && isUserAdmin) {
        lastImageId = event.message.id;
        return await sendReply(event.replyToken, "📷 รับรูปเมนูแล้ว! ถ้าจะใช้รูปนี้ พิมพ์: SET_ADMIN_IMAGE");
    }

    if (event.type === "message" && event.message.type === "text") {
      const rawMsg = event.message.text.trim();
      const userMsg = rawMsg.toUpperCase();

      try {
        if (userMsg === "USER_LINE") {
            return await sendReply(event.replyToken, `รหัส User ID ของคุณคือ:\n${userId}`);
        }

        if (isUserAdmin) {
            // --- [แทรก] คำสั่งอัปโหลดรูปผ่านไลน์ ---
            if (userMsg === "SET_ADMIN_IMAGE") {
                if (!lastImageId) return await sendReply(event.replyToken, "❌ กรุณาส่งรูปภาพมาก่อนค่ะ");
                await uploadMenuImage(lastImageId, process.env.ADMIN_RICHMENU_ID, event.replyToken);
                lastImageId = null; 
                return;
            }
            // --- 🛠 หมวดสลับ Rich Menu ---
            else if (userMsg === "SWITCH_TO_ADMIN") {
                try {
                    await linkRichMenu(userId, process.env.ADMIN_RICHMENU_ID, event.replyToken);
                    return await sendReply(event.replyToken, "🔓 เข้าสู่โหมดแอดมินสำเร็จ!");
                } catch (e) { return; }
            }
            else if (userMsg === "SWITCH_TO_USER") {
                try {
                    await linkRichMenu(userId, process.env.USER_RICHMENU_ID, event.replyToken);
                    return await sendReply(event.replyToken, "👤 กลับสู่โหมดลูกค้าสำเร็จ!");
                } catch (e) { return; }
            }
            else if (userMsg === "SET_USER_DEFAULT") {
                try {
                    await axios.post(`https://api.line.me/v2/bot/user/all/richmenu/${process.env.USER_RICHMENU_ID}`, {}, {
                        headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
                    });
                    return await sendReply(event.replyToken, "🌍 ตั้งเมนูลูกค้าเป็นค่าเริ่มต้นแล้ว!");
                } catch (e) {
                    return await sendReply(event.replyToken, "❌ ตั้งค่าไม่สำเร็จ: " + e.message);
                }
            }
            // --- 📊 หมวดรายงาน & จัดการแต้ม ---
            else if (userMsg.startsWith("USAGE ")) {
                return await getCustomerReport(rawMsg.split(" ")[1], event.replyToken, userId);
            }
            else if (userMsg === "RECENT_REPORTS") {
                return await listRecentUsers(event.replyToken);
            }
            else if (userMsg === "OK" || userMsg === "โอเค") {
                return await approvePoint(event.replyToken);
            }
            // --- 📋 หมวดจัดการไอดี & สร้างเมนู ---
            else if (userMsg === "GET_MENU_ID") {
                const resMenu = await axios.get("https://api.line.me/v2/bot/richmenu/list", {
                    headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
                });
                const menus = resMenu.data.richmenus;
                let msg = "📋 รายชื่อ Rich Menu ID:\n\n";
                menus.forEach((m, i) => msg += `${i+1}. ${m.chatBarText}\nID: ${m.richMenuId}\n---\n`);
                return await sendReply(event.replyToken, menus.length > 0 ? msg : "📭 ไม่พบเมนูค่ะ");
            }
            else if (userMsg === "CREATE_ADMIN_MENU") {
                try {
                    const richMenuObj = {
                        size: { width: 2500, height: 843 }, selected: false,
                        name: "Admin God Mode", chatBarText: "เมนูแอดมิน 🔓",
                        areas: [
                            // แบ่ง 3 ช่องเท่ากัน ช่องละ 833px สูง 843px
                            { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: "message", text: "RECENT_REPORTS" } },
                            { bounds: { x: 833, y: 0, width: 833, height: 843 }, action: { type: "message", text: "OK" } },
                            { bounds: { x: 1666, y: 0, width: 834, height: 843 }, action: { type: "message", text: "SWITCH_TO_USER" } }
                        ]
                    };
                    const res = await axios.post("https://api.line.me/v2/bot/richmenu", richMenuObj, {
                        headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
                    });
                    return await sendReply(event.replyToken, `✅ สร้างสำเร็จ!\nID: ${res.data.richMenuId}\n\n⚠️ ก๊อปใส่ Railway ADMIN_RICHMENU_ID นะคะ`);
                } catch (e) {
                    return await sendReply(event.replyToken, "❌ สร้างไม่ได้: " + (e.response?.data?.message || e.message));
                }
            }
            else if (userMsg === "LIST_ADMIN") {
                const { data: admins } = await supabase.from("bot_admins").select("*");
                return await sendReply(event.replyToken, `🔐 แอดมิน: \n${admins.map(a => `- ${a.admin_name} (${a.line_user_id.substring(0,6)})`).join('\n')}`);
            }
        }

        const { data: member } = await supabase.from("ninetyMember").select("id").eq("line_user_id", userId).single();
        if (member) {
            if (userMsg === "CHECK_POINT") {
                const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", member.id).single();
                await sendReply(event.replyToken, `🌟 คุณมี: ${w?.point_balance || 0} แต้ม`);
            } else if (userMsg === "REFUND") {
                await handleRefund(member.id, event.replyToken);
            }
        }
      } catch (e) { console.error(e.message); }
    }
  }
  res.sendStatus(200);
});

/* ====================================
   5. HELPER FUNCTIONS
==================================== */
async function isAdmin(uid) {
    const { data } = await supabase.from("bot_admins").select("line_user_id").eq("line_user_id", uid).single();
    return !!data;
}

// [แทรก] ฟังก์ชันอัปโหลดรูปภาพผ่านไลน์
async function uploadMenuImage(messageId, richMenuId, replyToken) {
    try {
        const response = await axios.get(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
            headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
            responseType: 'arraybuffer'
        });
        await axios.post(`https://api.line.me/v2/bot/richmenu/${richMenuId}/content`, response.data, {
            headers: { 
                'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
                'Content-Type': 'image/png' 
            }
        });
        await sendReply(replyToken, "🎨 อัปโหลดรูปภาพสำเร็จแล้ว! ลองกด SWITCH_TO_ADMIN ได้เลยค่ะ");
    } catch (e) {
        await sendReply(replyToken, "❌ อัปโหลดรูปไม่สำเร็จ: " + (e.response?.data?.message || e.message));
    }
}

// สลับเมนูพร้อม Debug
async function linkRichMenu(uid, rid, replyToken) {
    try {
        await axios.post(`https://api.line.me/v2/bot/user/${uid}/richmenu/${rid}`, {}, {
            headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
        });
    } catch (e) {
        const errorFull = JSON.stringify(e.response?.data || { message: e.message }, null, 2);
        await sendReply(replyToken, `❌ สลับไม่สำเร็จ!\nID: ${rid}\n\nรายละเอียด Error:\n${errorFull}`);
        throw e;
    }
}

async function getCustomerReport(targetUid, replyToken, adminId) {
    const { data: earns } = await supabase.from("qrPointToken").select("*").eq("used_by", targetUid).limit(5).order("used_at", { ascending: false });
    const flex = {
        type: "flex", altText: "รายงานลูกค้า",
        contents: {
            type: "bubble",
            body: {
                type: "box", layout: "vertical", contents: [
                    { type: "text", text: "📊 รายงานล่าสุด", weight: "bold", size: "lg" },
                    { type: "separator", margin: "md" },
                    ...earns.map(e => ({
                        type: "box", layout: "horizontal", contents: [
                            { type: "text", text: new Date(e.used_at).toLocaleDateString('th'), size: "xs" },
                            { type: "text", text: `+${e.point_get} pts`, align: "end", color: "#00b900", size: "xs" }
                        ]
                    }))
                ]
            },
            footer: {
                type: "box", layout: "vertical", contents: [{
                    type: "button", style: "primary", color: "#00b900",
                    action: { type: "uri", label: "ดาวน์โหลด PDF", uri: `https://${process.env.RAILWAY_STATIC_URL}/api/report-pdf?userId=${targetUid}&adminId=${adminId}` }
                }]
            }
        }
    };
    await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken, messages: [flex] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}

async function listRecentUsers(replyToken) {
    const { data: recent } = await supabase.from("point_requests").select("line_user_id").limit(5).order("request_at", { ascending: false });
    const quickItems = recent.map(u => ({ type: "action", action: { type: "message", label: u.line_user_id.substring(0, 8), text: `USAGE ${u.line_user_id}` }}));
    await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken, messages: [{ type: "text", text: "เลือกลูกค้า:", quickReply: { items: quickItems } }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}

async function approvePoint(replyToken) {
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  const { data: reqRecord } = await supabase.from("point_requests").select("*").gt("request_at", oneDayAgo).order("request_at", { ascending: true }).limit(1).single();
  if (reqRecord) {
    const { data: m } = await supabase.from("ninetyMember").select("id").eq("line_user_id", reqRecord.line_user_id).single();
    if (m) {
        const { data: w } = await supabase.from("memberWallet").select("point_balance").eq("member_id", m.id).single();
        const newTotal = (w?.point_balance || 0) + reqRecord.points;
        await supabase.from("memberWallet").upsert({ member_id: m.id, point_balance: newTotal }, { onConflict: 'member_id' });
        await supabase.from("point_requests").delete().eq("id", reqRecord.id);
        await sendReply(replyToken, `✅ อนุมัติสำเร็จ!\n🌟 ยอดรวม: ${newTotal} แต้ม`);
        await sendReplyPush(reqRecord.line_user_id, `🎊 แอดมินเติมแต้มให้ ${reqRecord.points} แต้มค่ะ`);
    }
  } else {
    await sendReply(replyToken, "❌ ไม่พบรายการคำขอค่ะ");
  }
}

async function handleRefund(memberId, replyToken) {
  const { data: log } = await supabase.from("redeemlogs").select("*").eq("member_id", memberId).eq("status", 'pending').order("created_at", { ascending: false }).limit(1).single();
  if (!log) return await sendReply(replyToken, "❌ ไม่พบรายการคืนแต้ม");
  const { data: wallet } = await supabase.from("memberWallet").select("point_balance").eq("member_id", memberId).single();
  const newTotal = (wallet?.point_balance || 0) + log.points_redeemed;
  await supabase.from("memberWallet").update({ point_balance: newTotal }).eq("member_id", memberId);
  await supabase.from("redeemlogs").update({ status: 'refunded' }).eq("id", log.id);
  await sendReply(replyToken, `💰 คืนแต้มสำเร็จ! ยอดรวม: ${newTotal}`);
}

async function sendReply(replyToken, text) {
  await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}
async function sendReplyPush(to, text) {
  await axios.post("https://api.line.me/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }});
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 God Mode Server on port ${PORT}`));
