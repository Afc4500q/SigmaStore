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

      // ====================================================
      // 1. معالجة رسائل وأوامر وصور البوت من Telegram
      // ====================================================
      if (data.message) {
        const chatId = String(data.message.chat.id);
        const text = (data.message.text || data.message.caption || "").trim();
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

        const sendReply = async (replyText) => {
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: replyText })
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

        // مساعدة
        if (text === "/start" || text === "/help") {
          const helpMsg = 
`🛠 لوحة تحكم منتجات SIGMA STORE:

📸 1️⃣ لإضافة منتج بصورة من جهازك:
أرسل الصورة من الهاتف واكتب في خانة الوصف (Caption):
/add اسم المنتج | السعر
مثال:
/add كفر حماية ايفون | 12000

🗑️ 2️⃣ لحذف منتج:
/delete معرف_المنتج
مثال: /delete 2

✏️ 3️⃣ لتعديل سعر:
/edit معرف_المنتج | السعر_الجديد
مثال: /edit 1 | 30000

📦 4️⃣ لعرض المنتجات:
/list`;
          await sendReply(helpMsg);
          return new Response("OK", { status: 200 });
        }

        // عرض القائمة
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

        // إضافة منتج (مع صورة مرفقة من الجهاز)
        if (text.startsWith("/add")) {
          const raw = text.replace("/add", "").trim();
          const parts = raw.split("|").map(s => s.trim());

          if (parts.length < 2) {
            await sendReply("⚠️ الصيغة غير صحيحة.\nاكتب في وصف الصورة:\n/add اسم المنتج | السعر");
            return new Response("OK", { status: 200 });
          }

          const [name, priceStr] = parts;
          const price = parseInt(priceStr.replace(/[^0-9]/g, ""), 10);
          let imgPath = parts[2] || "img/placeholder.jpg";

          // إذا كانت الرسالة تحتوي على صورة مرفوعة
          if (data.message.photo && data.message.photo.length > 0) {
            await sendReply("⏳ جاري رفع الصورة إلى GitHub وحفظ المنتج...");
            try {
              const bestPhoto = data.message.photo[data.message.photo.length - 1];
              const fileRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${bestPhoto.file_id}`);
              const fileData = await fileRes.json();
              
              if (fileData.ok) {
                const filePath = fileData.result.file_path;
                const fileDownloadUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
                const imgBlob = await fetch(fileDownloadUrl);
                const arrayBuffer = await imgBlob.arrayBuffer();
                
                // تحويل الصورة إلى Base64
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
            } catch (imgErr) {
              console.error("Image upload failed:", imgErr);
            }
          }

          try {
            const { sha, products } = await getProductsFromGithub();
            const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
            products.push({ id: newId, name, price, img: imgPath });

            await saveProductsToGithub(products, sha, `Add product: ${name}`);
            await sendReply(`✅ تم حفظ المنتج ورفع الصورة بنجاح!\n🆔 المعرف: ${newId}\n🏷️ الاسم: ${name}\n💰 السعر: ${price.toLocaleString()} د.ع\n🖼️ مسار الصورة: ${imgPath}`);
          } catch (err) {
            await sendReply("❌ فشلت الإضافة: " + err.message);
          }
          return new Response("OK", { status: 200 });
        }

        // حذف منتج
        if (text.startsWith("/delete")) {
          const targetId = parseInt(text.replace("/delete", "").trim(), 10);
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

        // تعديل سعر
        if (text.startsWith("/edit")) {
          const raw = text.replace("/edit", "").trim();
          const parts = raw.split("|").map(s => s.trim());
          const targetId = parseInt(parts[0], 10);
          const newPrice = parts[1] ? parseInt(parts[1].replace(/[^0-9]/g, ""), 10) : NaN;

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

      // ====================================================
      // 2. استقبال طلبات الشراء القادمة من المتجر
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
