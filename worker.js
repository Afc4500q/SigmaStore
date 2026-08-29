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

      // دالة مساعدة لقراءة الأسطر التلقائية (الاسم: ، السعر: ، إلخ)
      const parseKeyValues = (rawText) => {
        const result = {};
        const lines = rawText.split("\n");
        for (const line of lines) {
          const colonIndex = line.indexOf(":");
          if (colonIndex !== -1) {
            const key = line.substring(0, colonIndex).trim();
            const val = line.substring(colonIndex + 1).trim();
            if (key.includes("قسم")) result.category = val;
            if (key.includes("مارك") || key.includes("براند")) result.brand = val;
            if (key.includes("موديل")) result.model = val;
            if (key.includes("اسم")) result.name = val;
            if (key.includes("سعر")) result.price = parseInt(val.replace(/[^0-9]/g, ""), 10);
          }
        }
        return result;
      };

      // ====================================================
      // 1. معالجة رسائل، أوامر، وأزرار Telegram
      // ====================================================
      if (data.message || data.callback_query) {
        const isCallback = Boolean(data.callback_query);
        const chatId = String(isCallback ? data.callback_query.message.chat.id : data.message.chat.id);
        const callbackData = isCallback ? data.callback_query.data : null;
        const text = (isCallback ? "" : (data.message.text || data.message.caption || "")).trim();
        const allowedAdmins = [String(env.CHAT_ID_1), String(env.CHAT_ID_2)].filter(Boolean);

        if (!allowedAdmins.includes(chatId)) {
          return new Response("Unauthorized", { status: 200 });
        }

        const GITHUB_BASE = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/`;
        const ghHeaders = {
          "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
          "User-Agent": "SigmaStore-Worker",
          "Accept": "application/vnd.github.v3+json"
        };

        const mainKeyboard = {
          keyboard: [
            [{ text: "📦 عرض المنتجات" }, { text: "➕ إضافة منتج" }],
            [{ text: "❓ تعليمات الاستخدام" }]
          ],
          resize_keyboard: true
        };

        const sendReply = async (replyText, customKeyboard = mainKeyboard) => {
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: replyText,
              reply_markup: customKeyboard
            })
          });
        };

        const sendProductWithButtons = async (p) => {
          const inlineKeyboard = {
            inline_keyboard: [
              [
                { text: "✏️ تعديل كامل البيانات", callback_data: `edit_${p.id}` },
                { text: "🗑️ حذف المنتج", callback_data: `del_${p.id}` }
              ]
            ]
          };

          const pText = `🏷️ الاسم: ${p.name}\n📁 القسم: ${p.category || 'عام'}\n🏢 الماركة: ${p.brand || '-'}\n📱 الموديل: ${p.model || '-'}\n💰 السعر: ${p.price.toLocaleString()} د.ع\n🆔 المعرف: ${p.id}`;
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: pText,
              reply_markup: inlineKeyboard
            })
          });
        };

        const answerCallback = async (callbackQueryId, alertText) => {
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              callback_query_id: callbackQueryId,
              text: alertText,
              show_alert: false
            })
          });
        };

        const getProductsFromGithub = async () => {
          const res = await fetch(GITHUB_BASE + "products.json", { headers: ghHeaders });
          if (!res.ok) throw new Error("تعذر قراءة ملف products.json من GitHub");
          const fileData = await res.json();
          const content = decodeURIComponent(escape(atob(fileData.content.replace(/\s/g, ''))));
          return { sha: fileData.sha, products: JSON.parse(content || "[]") };
        };

        const saveProductsToGithub = async (newProducts, sha, commitMsg) => {
          const updatedContent = btoa(unescape(encodeURIComponent(JSON.stringify(newProducts, null, 2))));
          const res = await fetch(GITHUB_BASE + "products.json", {
            method: "PUT",
            headers: ghHeaders,
            body: JSON.stringify({ message: commitMsg, content: updatedContent, sha: sha })
          });
          if (!res.ok) throw new Error("فشل حفظ التعديلات في GitHub");
        };

        // تفاعل الأزرار
        if (isCallback) {
          if (callbackData.startsWith("del_")) {
            const targetId = parseInt(callbackData.replace("del_", ""), 10);
            try {
              const { sha, products } = await getProductsFromGithub();
              const index = products.findIndex(p => p.id === targetId);
              if (index !== -1) {
                const deletedName = products[index].name;
                products.splice(index, 1);
                await saveProductsToGithub(products, sha, `Delete product ID: ${targetId}`);
                await answerCallback(data.callback_query.id, `تم حذف ${deletedName}`);
                await sendReply(`🗑️ تم حذف (${deletedName}) بنجاح.`);
              } else {
                await answerCallback(data.callback_query.id, "المنتج غير موجود");
              }
            } catch (err) {
              await sendReply("❌ خطأ أثناء الحذف: " + err.message);
            }
          }

          if (callbackData.startsWith("edit_")) {
            const targetId = parseInt(callbackData.replace("edit_", ""), 10);
            await answerCallback(data.callback_query.id, "تم تجهيز البيانات");
            
            const { products } = await getProductsFromGithub();
            const currentItem = products.find(p => p.id === targetId);

            if (currentItem) {
              const template = 
`/edit ${targetId}
القسم: ${currentItem.category || 'عام'}
الماركة: ${currentItem.brand || '-'}
الموديل: ${currentItem.model || '-'}
الاسم: ${currentItem.name || ''}
السعر: ${currentItem.price}`;

              await sendReply(`✏️ انسخ الرسالة التالية، عدّل ما تريده، ثم أرسلها مباشرة:\n\n\`\`\`\n${template}\n\`\`\``);
            }
          }

          return new Response("OK", { status: 200 });
        }

        // القوائم والمساعدة
        if (text === "/start" || text === "❓ تعليمات الاستخدام") {
          const welcomeMsg = 
`👋 مرحباً بك في لوحة تحكم SIGMA STORE

📸 لإضافة منتج:
أرسل الصورة واكتب في الوصف:
القسم: الشواحن
الماركة: Samsung
الموديل: 45W
الاسم: شاحن سامسونج أصلي
السعر: 25000

✏️ لتعديل منتج:
اضغط على "عرض المنتجات" ثم اختر "تعديل كامل البيانات" تحت المنتج المطلوب.`;
          await sendReply(welcomeMsg);
          return new Response("OK", { status: 200 });
        }

        if (text === "➕ إضافة منتج") {
          const addInfo = 
`📸 طريقة إضافة منتج جديد:

1️⃣ اختر الصورة من الاستوديو.
2️⃣ اكتب في خانة الوصف (Caption):

القسم: الكيبلات
الماركة: Anker
الموديل: Type-C
الاسم: كيبل شحن سريع
السعر: 10000

📌 الأقسام المتوفرة بالموقع:
الكيبلات ، الهتفونات ، الايربود ، سماعات الراس ، الشواحن ، الموزعات`;
          await sendReply(addInfo);
          return new Response("OK", { status: 200 });
        }

        if (text === "📦 عرض المنتجات" || text === "/list") {
          try {
            const { products } = await getProductsFromGithub();
            if (products.length === 0) {
              await sendReply("📦 لا توجد منتجات مسجلة في المتجر حالياً.");
            } else {
              await sendReply(`📋 قائمة المنتجات (${products.length} منتج):`);
              for (const p of products) {
                await sendProductWithButtons(p);
              }
            }
          } catch (err) {
            await sendReply("❌ خطأ أثناء جلب المنتجات: " + err.message);
          }
          return new Response("OK", { status: 200 });
        }

        // إضافة منتج جديد من صورة مع وصف
        if (data.message.photo && data.message.photo.length > 0 && text) {
          const parsed = parseKeyValues(text);

          if (!parsed.name || isNaN(parsed.price)) {
            await sendReply("⚠️ يرجى التأكد من كتابة الاسم والسعر على الأقل:\nالاسم: اسم المنتج\nالسعر: 10000");
            return new Response("OK", { status: 200 });
          }

          let imgPath = "img/placeholder.jpg";
          await sendReply("⏳ جاري رفع الصورة وتحديث المتجر...");

          try {
            const bestPhoto = data.message.photo[data.message.photo.length - 1];
            const fileRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${bestPhoto.file_id}`);
            const fileData = await fileRes.json();
            
            if (fileData.ok) {
              const filePath = fileData.result.file_path;
              const fileDownloadUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
              const imgBlob = await fetch(fileDownloadUrl);
              const arrayBuffer = await imgBlob.arrayBuffer();
              
              let binary = '';
              const bytes = new Uint8Array(arrayBuffer);
              for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              const base64Image = btoa(binary);

              const fileName = `prod_${Date.now()}.jpg`;
              const ghImgRes = await fetch(GITHUB_BASE + `img/${fileName}`, {
                method: "PUT",
                headers: ghHeaders,
                body: JSON.stringify({
                  message: `Upload image: ${fileName}`,
                  content: base64Image
                })
              });

              if (ghImgRes.ok) {
                imgPath = `img/${fileName}`;
              }
            }

            const { sha, products } = await getProductsFromGithub();
            const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
            const newProd = {
              id: newId,
              category: parsed.category || "عام",
              brand: parsed.brand || "-",
              model: parsed.model || "-",
              name: parsed.name,
              price: parsed.price,
              img: imgPath
            };
            products.push(newProd);

            await saveProductsToGithub(products, sha, `Add product: ${parsed.name}`);
            await sendReply(`✅ تم إضافة المنتج بنجاح!`);
            await sendProductWithButtons(newProd);

          } catch (err) {
            await sendReply("❌ فشلت الإضافة: " + err.message);
          }
          return new Response("OK", { status: 200 });
        }

        // تعديل البيانات بالتنسيق الجديد
        if (text.startsWith("/edit")) {
          const firstLine = text.split("\n")[0];
          const targetId = parseInt(firstLine.replace("/edit", "").trim(), 10);

          if (isNaN(targetId)) {
            await sendReply("⚠️ يرجى تحديد رقم المنتج في السطر الأول:\n/edit 19");
            return new Response("OK", { status: 200 });
          }

          const parsed = parseKeyValues(text);

          try {
            const { sha, products } = await getProductsFromGithub();
            const item = products.find(p => p.id === targetId);

            if (!item) {
              await sendReply(`⚠️ لم يتم العثور على منتج برقم ${targetId}`);
            } else {
              if (parsed.category) item.category = parsed.category;
              if (parsed.brand) item.brand = parsed.brand;
              if (parsed.model) item.model = parsed.model;
              if (parsed.name) item.name = parsed.name;
              if (!isNaN(parsed.price)) item.price = parsed.price;

              await saveProductsToGithub(products, sha, `Update product ID: ${targetId}`);
              await sendReply(`✅ تم تحديث بيانات المنتج بنجاح!`);
              await sendProductWithButtons(item);
            }
          } catch (err) {
            await sendReply("❌ فشل التعديل: " + err.message);
          }
          return new Response("OK", { status: 200 });
        }

        return new Response("OK", { status: 200 });
      }

      // ====================================================
      // 2. استقبال طلبات الشراء
      // ====================================================
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
