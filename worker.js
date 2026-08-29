export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "Method Not Allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    try {
      const data = await request.json();

      // ==========================================
      // أولاً: معالجة رسائل وأوامر البوت من Telegram
      // ==========================================
      if (data.message && data.message.text) {
        const chatId = String(data.message.chat.id);
        const text = data.message.text.trim();
        const allowedAdmins = [String(env.CHAT_ID_1), String(env.CHAT_ID_2)].filter(Boolean);

        // التحقق من أن المرسل أدمن مصرح له
        if (!allowedAdmins.includes(chatId)) {
          return new Response("Unauthorized", { status: 200 });
        }

        // مسار ملف المنتجات في GitHub
        const FILE_PATH = "products.json";
        const GITHUB_API = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${FILE_PATH}`;
        const ghHeaders = {
          "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
          "User-Agent": "SigmaStore-Worker",
          "Accept": "application/vnd.github.v3+json"
        };

        // دالة مساعدة لإرسال رد في تيليجرام
        const sendReply = async (replyText) => {
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: replyText })
          });
        };

        // دالة جلب المنتجات الحالية من GitHub
        const getProductsFromGithub = async () => {
          const res = await fetch(GITHUB_API, { headers: ghHeaders });
          if (!res.ok) throw new Error("تعذر قراءة ملف products.json من GitHub");
          const fileData = await res.json();
          const content = decodeURIComponent(escape(atob(fileData.content.replace(/\s/g, ''))));
          return { sha: fileData.sha, products: JSON.parse(content || "[]") };
        };

        // دالة حفظ المنتجات في GitHub
        const saveProductsToGithub = async (newProducts, sha, commitMsg) => {
          const updatedContent = btoa(unescape(encodeURIComponent(JSON.stringify(newProducts, null, 2))));
          const res = await fetch(GITHUB_API, {
            method: "PUT",
            headers: ghHeaders,
            body: JSON.stringify({
              message: commitMsg,
              content: updatedContent,
              sha: sha
            })
          });
          if (!res.ok) throw new Error("فشل حفظ التعديلات في GitHub");
        };

        // أمر المساعدة /start
        if (text === "/start" || text === "/help") {
          const helpMsg = 
`🛠 لوحة تحكم منتجات SIGMA STORE:

1️⃣ إضافة منتج جديد:
/add الاسم | السعر | مسار الصورة
مثال:
/add شاشة ايفون 12 | 45000 | img/screen12.jpg

2️⃣ حذف منتج:
/delete معرف_المنتج
مثال:
/delete 2

3️⃣ تعديل السعر:
/edit معرف_المنتج | السعر_الجديد
مثال:
/edit 1 | 30000

4️⃣ عرض قائمة المنتجات:
/list`;
          await sendReply(helpMsg);
          return new Response("OK", { status: 200 });
        }

        // أمر عرض المنتجات /list
        if (text === "/list") {
          try {
            const { products } = await getProductsFromGithub();
            if (products.length === 0) {
              await sendReply("📦 لا توجد منتجات مسجلة حالياً.");
            } else {
              let listMsg = "📦 قائمة المنتجات الحالية:\n\n";
              products.forEach(p => {
                listMsg += `🆔 المعرف: ${p.id}\n🏷️ الاسم: ${p.name}\n💰 السعر: ${p.price.toLocaleString()} د.ع\n🖼️ الصورة: ${p.img}\n─────────────\n`;
              });
              await sendReply(listMsg);
            }
          } catch (err) {
            await sendReply("❌ خطأ أثناء جلب المنتجات: " + err.message);
          }
          return new Response("OK", { status: 200 });
        }

        // أمر الإضافة /add
        if (text.startsWith("/add")) {
          const raw = text.replace("/add", "").trim();
          const parts = raw.split("|").map(s => s.trim());
          if (parts.length < 3) {
            await sendReply("⚠️ صيغة غير صحيحة.\nالصيغة: /add الاسم | السعر | مسار الصورة");
            return new Response("OK", { status: 200 });
          }

          const [name, priceStr, img] = parts;
          const price = parseInt(priceStr.replace(/[^0-9]/g, ""), 10);

          try {
            const { sha, products } = await getProductsFromGithub();
            const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
            const newProduct = { id: newId, name, price, img };
            products.push(newProduct);

            await saveProductsToGithub(products, sha, `Add product: ${name}`);
            await sendReply(`✅ تم إضافة المنتج بنجاح!\n🆔 المعرف: ${newId}\n🏷️ الاسم: ${name}\n💰 السعر: ${price.toLocaleString()} د.ع`);
          } catch (err) {
            await sendReply("❌ فشلت الإضافة: " + err.message);
          }
          return new Response("OK", { status: 200 });
        }

        // أمر الحذف /delete
        if (text.startsWith("/delete")) {
          const targetId = parseInt(text.replace("/delete", "").trim(), 10);
          if (isNaN(targetId)) {
            await sendReply("⚠️ يرجى كتابة رقم المنتج، مثال: /delete 2");
            return new Response("OK", { status: 200 });
          }

          try {
            const { sha, products } = await getProductsFromGithub();
            const index = products.findIndex(p => p.id === targetId);
            if (index === -1) {
              await sendReply(`⚠️ لم يتم العثور على منتج بالرقم ${targetId}`);
            } else {
              const deletedName = products[index].name;
              products.splice(index, 1);
              await saveProductsToGithub(products, sha, `Delete product ID: ${targetId}`);
              await sendReply(`🗑️ تم حذف المنتج (${deletedName}) بنجاح.`);
            }
          } catch (err) {
            await sendReply("❌ فشل الحذف: " + err.message);
          }
          return new Response("OK", { status: 200 });
        }

        // أمر تعديل السعر /edit
        if (text.startsWith("/edit")) {
          const raw = text.replace("/edit", "").trim();
          const parts = raw.split("|").map(s => s.trim());
          const targetId = parseInt(parts[0], 10);
          const newPrice = parts[1] ? parseInt(parts[1].replace(/[^0-9]/g, ""), 10) : NaN;

          if (isNaN(targetId) || isNaN(newPrice)) {
            await sendReply("⚠️ صيغة غير صحيحة.\nالصيغة: /edit رقم_المنتج | السعر_الجديد\nمثال: /edit 1 | 30000");
            return new Response("OK", { status: 200 });
          }

          try {
            const { sha, products } = await getProductsFromGithub();
            const item = products.find(p => p.id === targetId);
            if (!item) {
              await sendReply(`⚠️ لم يتم العثور على منتج بالرقم ${targetId}`);
            } else {
              item.price = newPrice;
              await saveProductsToGithub(products, sha, `Update price for ID: ${targetId}`);
              await sendReply(`✏️ تم تحديث سعر (${item.name}) إلى ${newPrice.toLocaleString()} د.ع بنجاح.`);
            }
          } catch (err) {
            await sendReply("❌ فشل التعديل: " + err.message);
          }
          return new Response("OK", { status: 200 });
        }

        return new Response("OK", { status: 200 });
      }

      // ==========================================
      // ثانياً: استقبال طلبات الشراء القادمة من المتجر
      // ==========================================
      const phone = String(data.phone || "").trim();
      const address = String(data.address || "").trim();
      const products = String(data.products || "").trim();
      const total = String(data.total || "").trim();
      const orderNumber = String(data.orderNumber || "").trim();
      const date = String(data.date || "").trim();

      if (!phone || !address || !products) {
        return new Response(JSON.stringify({ ok: false, error: "بيانات الطلب غير مكتملة" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const message = 
`🛒 طلب جديد #${orderNumber}

━━━━━━━━━━━━━━

📦 المنتجات:
${products}

━━━━━━━━━━━━━━

💰 الإجمالي:
${total}

📱 رقم الموبايل:
${phone}

📍 عنوان السكن:
${address}

🕐 وقت الطلب:
${date}

━━━━━━━━━━━━━━
SIGMA STORE`;

      const chatIds = [env.CHAT_ID_1, env.CHAT_ID_2].filter(Boolean);
      for (const chatId of chatIds) {
        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: message })
        });
      }

      return new Response(JSON.stringify({ ok: true, message: "تم إرسال الطلب بنجاح" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (error) {
      console.error("Worker Error:", error);
      return new Response(JSON.stringify({ ok: false, error: error.message || "حدث خطأ في الخادم" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
