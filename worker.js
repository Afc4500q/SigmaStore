export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    const jsonResponse = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method Not Allowed" }, 405);
    }

    try {
      const data = await request.json();

      // ====================================================
      // دالة مساعدة لقراءة الأسطر: الاسم، السعر، إلخ
      // ====================================================
      const parseKeyValues = (rawText) => {
        const result = {};
        const lines = String(rawText || "").split(/\r?\n/);

        for (const line of lines) {
          const colonIndex = line.indexOf(":");
          if (colonIndex === -1) continue;

          const key = line.substring(0, colonIndex).trim();
          const val = line.substring(colonIndex + 1).trim();
          if (!val) continue;

          if (key.includes("قسم")) result.category = val;
          if (key.includes("مارك") || key.includes("براند")) result.brand = val;
          if (key.includes("موديل")) result.model = val;
          if (key.includes("اسم")) result.name = val;

          if (key.includes("سعر")) {
            // يدعم الأرقام العربية والهندية أيضًا
            const normalized = val
              .replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
              .replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));

            const digits = normalized.replace(/[^0-9]/g, "");
            if (digits) result.price = parseInt(digits, 10);
          }
        }

        return result;
      };

      // ====================================================
      // 1. معالجة Telegram
      // ====================================================
      if (data.message || data.callback_query) {
        const isCallback = Boolean(data.callback_query);

        const callbackMessage = isCallback
          ? data.callback_query.message
          : null;

        const message = isCallback
          ? null
          : data.message;

        const rawChatId = isCallback
          ? callbackMessage?.chat?.id
          : message?.chat?.id;

        if (rawChatId === undefined || rawChatId === null) {
          return new Response("OK", { status: 200 });
        }

        const chatId = String(rawChatId);
        const callbackData = isCallback
          ? String(data.callback_query.data || "")
          : "";

        const text = (
          isCallback
            ? ""
            : (message.text || message.caption || "")
        ).trim();

        const allowedAdmins = [
          env.CHAT_ID_1,
          env.CHAT_ID_2
        ]
          .filter(value => value !== undefined && value !== null && String(value).trim() !== "")
          .map(value => String(value).trim());

        if (!allowedAdmins.includes(chatId)) {
          return new Response("Unauthorized", { status: 200 });
        }

        if (!env.BOT_TOKEN) {
          throw new Error("BOT_TOKEN غير موجود في متغيرات البيئة");
        }

        const GITHUB_BASE = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/`;

        const ghHeaders = {
          "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
          "User-Agent": "SigmaStore-Worker",
          "Accept": "application/vnd.github+json"
        };

        const mainKeyboard = {
          keyboard: [
            [{ text: "📦 عرض المنتجات" }, { text: "➕ إضافة منتج" }],
            [{ text: "❓ تعليمات الاستخدام" }]
          ],
          resize_keyboard: true
        };

        const telegramRequest = async (method, body) => {
          const res = await fetch(
            `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            }
          );

          const result = await res.json().catch(() => null);

          if (!res.ok || !result?.ok) {
            throw new Error(
              `Telegram ${method} failed: ${result?.description || res.statusText || "Unknown error"}`
            );
          }

          return result;
        };

        const sendReply = async (
          replyText,
          customKeyboard = mainKeyboard
        ) => {
          return telegramRequest("sendMessage", {
            chat_id: chatId,
            text: replyText,
            reply_markup: customKeyboard
          });
        };

        const sendProductWithButtons = async (p) => {
          const inlineKeyboard = {
            inline_keyboard: [
              [
                {
                  text: "✏️ تعديل كامل البيانات",
                  callback_data: `edit_${p.id}`
                },
                {
                  text: "🗑️ حذف المنتج",
                  callback_data: `del_${p.id}`
                }
              ]
            ]
          };

          const price = Number(p.price) || 0;

          const pText =
`🏷️ الاسم: ${p.name || "-"}
📁 القسم: ${p.category || "عام"}
🏢 الماركة: ${p.brand || "-"}
📱 الموديل: ${p.model || "-"}
💰 السعر: ${price.toLocaleString("en-US")} د.ع
🆔 المعرف: ${p.id}`;

          return telegramRequest("sendMessage", {
            chat_id: chatId,
            text: pText,
            reply_markup: inlineKeyboard
          });
        };

        const answerCallback = async (
          callbackQueryId,
          alertText
        ) => {
          try {
            await telegramRequest("answerCallbackQuery", {
              callback_query_id: callbackQueryId,
              text: alertText || "",
              show_alert: false
            });
          } catch (err) {
            console.error("Callback answer error:", err);
          }
        };

        const getProductsFromGithub = async () => {
          if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) {
            throw new Error("GITHUB_REPO أو GITHUB_TOKEN غير موجود");
          }

          const res = await fetch(
            GITHUB_BASE + "products.json",
            { headers: ghHeaders }
          );

          const fileData = await res.json().catch(() => null);

          if (!res.ok || !fileData?.content) {
            throw new Error(
              `تعذر قراءة products.json من GitHub: ${
                fileData?.message || res.statusText
              }`
            );
          }

          const encoded = fileData.content.replace(/\s/g, "");

          let content;
          try {
            content = decodeURIComponent(
              escape(atob(encoded))
            );
          } catch {
            throw new Error("تعذر فك ترميز products.json");
          }

          let products;
          try {
            products = JSON.parse(content || "[]");
          } catch {
            throw new Error("ملف products.json ليس JSON صالحًا");
          }

          if (!Array.isArray(products)) {
            throw new Error("products.json يجب أن يحتوي على مصفوفة منتجات");
          }

          return {
            sha: fileData.sha,
            products
          };
        };

        const saveProductsToGithub = async (
          newProducts,
          sha,
          commitMsg
        ) => {
          const jsonString = JSON.stringify(
            newProducts,
            null,
            2
          );

          const updatedContent = btoa(
            unescape(encodeURIComponent(jsonString))
          );

          const res = await fetch(
            GITHUB_BASE + "products.json",
            {
              method: "PUT",
              headers: {
                ...ghHeaders,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                message: commitMsg,
                content: updatedContent,
                sha
              })
            }
          );

          const result = await res.json().catch(() => null);

          if (!res.ok) {
            throw new Error(
              `فشل حفظ التعديلات في GitHub: ${
                result?.message || res.statusText
              }`
            );
          }

          return result;
        };

        // ====================================================
        // تفاعل أزرار Telegram
        // ====================================================
        if (isCallback) {
          if (callbackData.startsWith("del_")) {
            const targetId = parseInt(
              callbackData.replace("del_", ""),
              10
            );

            if (isNaN(targetId)) {
              await answerCallback(
                data.callback_query.id,
                "معرف المنتج غير صالح"
              );
              return new Response("OK", { status: 200 });
            }

            try {
              const { sha, products } =
                await getProductsFromGithub();

              const index = products.findIndex(
                p => Number(p.id) === targetId
              );

              if (index !== -1) {
                const deletedName =
                  products[index].name || "المنتج";

                products.splice(index, 1);

                await saveProductsToGithub(
                  products,
                  sha,
                  `Delete product ID: ${targetId}`
                );

                await answerCallback(
                  data.callback_query.id,
                  `تم حذف ${deletedName}`
                );

                await sendReply(
                  `🗑️ تم حذف (${deletedName}) بنجاح.`
                );
              } else {
                await answerCallback(
                  data.callback_query.id,
                  "المنتج غير موجود"
                );
              }
            } catch (err) {
              console.error("Delete error:", err);

              await answerCallback(
                data.callback_query.id,
                "حدث خطأ أثناء الحذف"
              );

              await sendReply(
                "❌ خطأ أثناء الحذف: " +
                (err.message || "خطأ غير معروف")
              );
            }

            return new Response("OK", { status: 200 });
          }

          if (callbackData.startsWith("edit_")) {
            const targetId = parseInt(
              callbackData.replace("edit_", ""),
              10
            );

            if (isNaN(targetId)) {
              await answerCallback(
                data.callback_query.id,
                "معرف المنتج غير صالح"
              );
              return new Response("OK", { status: 200 });
            }

            await answerCallback(
              data.callback_query.id,
              "تم تجهيز البيانات"
            );

            try {
              const { products } =
                await getProductsFromGithub();

              const currentItem = products.find(
                p => Number(p.id) === targetId
              );

              if (!currentItem) {
                await sendReply(
                  `⚠️ لم يتم العثور على منتج برقم ${targetId}`
                );
              } else {
                const template =
`/edit ${targetId}
القسم: ${currentItem.category || "عام"}
الماركة: ${currentItem.brand || "-"}
الموديل: ${currentItem.model || "-"}
الاسم: ${currentItem.name || ""}
السعر: ${Number(currentItem.price) || 0}`;

                await sendReply(
`✏️ انسخ الرسالة التالية، عدّل ما تريده، ثم أرسلها مباشرة:

${template}`
                );
              }
            } catch (err) {
              await sendReply(
                "❌ خطأ أثناء تجهيز التعديل: " +
                (err.message || "خطأ غير معروف")
              );
            }

            return new Response("OK", { status: 200 });
          }

          return new Response("OK", { status: 200 });
        }

        // ====================================================
        // القوائم والمساعدة
        // ====================================================
        if (
          text === "/start" ||
          text === "❓ تعليمات الاستخدام"
        ) {
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
اضغط على "📦 عرض المنتجات" ثم اختر "تعديل كامل البيانات" تحت المنتج المطلوب.

🗑️ يمكنك حذف أي منتج من زر "حذف المنتج".`;

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

        // ====================================================
        // عرض المنتجات
        // ====================================================
        if (
          text === "📦 عرض المنتجات" ||
          text === "/list"
        ) {
          try {
            const { products } =
              await getProductsFromGithub();

            if (products.length === 0) {
              await sendReply(
                "📦 لا توجد منتجات مسجلة في المتجر حالياً."
              );
            } else {
              await sendReply(
                `📋 قائمة المنتجات (${products.length} منتج):`
              );

              for (const p of products) {
                await sendProductWithButtons(p);
              }
            }
          } catch (err) {
            await sendReply(
              "❌ خطأ أثناء جلب المنتجات: " +
              (err.message || "خطأ غير معروف")
            );
          }

          return new Response("OK", { status: 200 });
        }

        // ====================================================
        // إضافة منتج جديد من صورة + وصف
        // ====================================================
        if (
          message?.photo &&
          message.photo.length > 0 &&
          text
        ) {
          const parsed = parseKeyValues(text);

          if (
            !parsed.name ||
            parsed.price === undefined ||
            isNaN(parsed.price)
          ) {
            await sendReply(
`⚠️ يرجى التأكد من كتابة الاسم والسعر على الأقل:

الاسم: اسم المنتج
السعر: 10000`
            );

            return new Response("OK", { status: 200 });
          }

          let imgPath = "img/placeholder.jpg";

          await sendReply(
            "⏳ جاري رفع الصورة وتحديث المتجر..."
          );

          try {
            const bestPhoto =
              message.photo[message.photo.length - 1];

            // الحصول على مسار الصورة من Telegram
            const fileRes = await fetch(
              `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(bestPhoto.file_id)}`
            );

            const fileData =
              await fileRes.json().catch(() => null);

            if (!fileRes.ok || !fileData?.ok) {
              throw new Error(
                "تعذر الحصول على ملف الصورة من Telegram"
              );
            }

            const filePath =
              fileData.result.file_path;

            const fileDownloadUrl =
              `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;

            const imgRes =
              await fetch(fileDownloadUrl);

            if (!imgRes.ok) {
              throw new Error(
                "تعذر تنزيل الصورة من Telegram"
              );
            }

            const arrayBuffer =
              await imgRes.arrayBuffer();

            const bytes =
              new Uint8Array(arrayBuffer);

            let binary = "";

            // تحويل الصورة إلى Base64
            const CHUNK_SIZE = 0x8000;

            for (
              let i = 0;
              i < bytes.length;
              i += CHUNK_SIZE
            ) {
              const chunk =
                bytes.subarray(
                  i,
                  Math.min(i + CHUNK_SIZE, bytes.length)
                );

              binary += String.fromCharCode(...chunk);
            }

            const base64Image = btoa(binary);

            const fileName =
              `prod_${Date.now()}_${Math.random()
                .toString(36)
                .slice(2, 8)}.jpg`;

            const ghImgRes = await fetch(
              GITHUB_BASE + `img/${fileName}`,
              {
                method: "PUT",
                headers: {
                  ...ghHeaders,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  message: `Upload image: ${fileName}`,
                  content: base64Image
                })
              }
            );

            const ghImgData =
              await ghImgRes.json().catch(() => null);

            if (!ghImgRes.ok) {
              throw new Error(
                `فشل رفع الصورة إلى GitHub: ${
                  ghImgData?.message || ghImgRes.statusText
                }`
              );
            }

            imgPath = `img/${fileName}`;

            // قراءة المنتجات بعد رفع الصورة مباشرة
            const {
              sha,
              products
            } = await getProductsFromGithub();

            const numericIds = products
              .map(p => Number(p.id))
              .filter(Number.isFinite);

            const newId =
              numericIds.length > 0
                ? Math.max(...numericIds) + 1
                : 1;

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

            await saveProductsToGithub(
              products,
              sha,
              `Add product: ${parsed.name}`
            );

            await sendReply(
              "✅ تم إضافة المنتج بنجاح!"
            );

            await sendProductWithButtons(newProd);

          } catch (err) {
            console.error("Add product error:", err);

            await sendReply(
              "❌ فشلت الإضافة: " +
              (err.message || "خطأ غير معروف")
            );
          }

          return new Response("OK", { status: 200 });
        }

        // ====================================================
        // تعديل بيانات المنتج
        // ====================================================
        if (
          text === "/edit" ||
          text.startsWith("/edit ")
        ) {
          const firstLine =
            text.split(/\r?\n/)[0];

          const targetId = parseInt(
            firstLine
              .replace(/^\/edit(?:@\w+)?/, "")
              .trim(),
            10
          );

          if (isNaN(targetId)) {
            await sendReply(
`⚠️ يرجى تحديد رقم المنتج في السطر الأول:

/edit 19`
            );

            return new Response("OK", { status: 200 });
          }

          const parsed =
            parseKeyValues(text);

          try {
            const {
              sha,
              products
            } = await getProductsFromGithub();

            const item =
              products.find(
                p => Number(p.id) === targetId
              );

            if (!item) {
              await sendReply(
                `⚠️ لم يتم العثور على منتج برقم ${targetId}`
              );
            } else {
              if (parsed.category !== undefined)
                item.category = parsed.category;

              if (parsed.brand !== undefined)
                item.brand = parsed.brand;

              if (parsed.model !== undefined)
                item.model = parsed.model;

              if (parsed.name !== undefined)
                item.name = parsed.name;

              if (
                parsed.price !== undefined &&
                !isNaN(parsed.price)
              ) {
                item.price = parsed.price;
              }

              await saveProductsToGithub(
                products,
                sha,
                `Update product ID: ${targetId}`
              );

              await sendReply(
                "✅ تم تحديث بيانات المنتج بنجاح!"
              );

              await sendProductWithButtons(item);
            }
          } catch (err) {
            console.error("Edit product error:", err);

            await sendReply(
              "❌ فشل التعديل: " +
              (err.message || "خطأ غير معروف")
            );
          }

          return new Response("OK", { status: 200 });
        }

        return new Response("OK", { status: 200 });
      }

      // ====================================================
      // 2. استقبال طلبات الشراء من الموقع
      // ====================================================
      const phone =
        String(data.phone || "").trim();

      const address =
        String(data.address || "").trim();

      const products =
        String(data.products || "").trim();

      const total =
        String(data.total || "").trim();

      const orderNumber =
        String(data.orderNumber || "").trim();

      const date =
        String(data.date || "").trim();

      if (!phone || !address || !products) {
        return jsonResponse(
          {
            ok: false,
            error: "بيانات الطلب غير مكتملة"
          },
          400
        );
      }

      if (!env.BOT_TOKEN) {
        throw new Error(
          "BOT_TOKEN غير موجود في متغيرات البيئة"
        );
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

      const chatIds = [
        env.CHAT_ID_1,
        env.CHAT_ID_2
      ]
        .filter(value => value !== undefined && value !== null && String(value).trim() !== "")
        .map(value => String(value).trim());

      if (chatIds.length === 0) {
        throw new Error(
          "لم يتم تعريف CHAT_ID_1 أو CHAT_ID_2"
        );
      }

      for (const targetChatId of chatIds) {
        const result =
          await telegramRequestOutside(
            env.BOT_TOKEN,
            targetChatId,
            message
          );

        if (!result.ok) {
          console.error(
            "Order Telegram error:",
            result
          );
        }
      }

      return jsonResponse({
        ok: true,
        message: "تم إرسال الطلب بنجاح"
      });

    } catch (error) {
      console.error(
        "Worker Error:",
        error
      );

      return jsonResponse(
        {
          ok: false,
          error:
            error?.message ||
            "حدث خطأ في الخادم"
        },
        500
      );
    }
  }
};

// إرسال رسالة Telegram خارج قسم لوحة التحكم
async function telegramRequestOutside(
  botToken,
  chatId,
  text
) {
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text
      })
    }
  );

  const result =
    await res.json().catch(() => null);

  if (!res.ok || !result?.ok) {
    throw new Error(
      `Telegram sendMessage failed: ${
        result?.description ||
        res.statusText ||
        "Unknown error"
      }`
    );
  }

  return result;
}
