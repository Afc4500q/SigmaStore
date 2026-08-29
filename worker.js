export default {
    async fetch(request, env) {

        // ==============================
        // CORS
        // ==============================

        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        };


        // ==============================
        // OPTIONS
        // ==============================

        if (request.method === "OPTIONS") {

            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });

        }


        // ==============================
        // السماح بـ POST فقط
        // ==============================

        if (request.method !== "POST") {

            return new Response(
                JSON.stringify({
                    ok: false,
                    error: "Method Not Allowed"
                }),
                {
                    status: 405,
                    headers: {
                        ...corsHeaders,
                        "Content-Type": "application/json"
                    }
                }
            );

        }


        try {

            // ==============================
            // قراءة البيانات القادمة من الموقع
            // ==============================

            const data = await request.json();


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


            // ==============================
            // التحقق
            // ==============================

            if (!phone || !address || !products) {

                return new Response(
                    JSON.stringify({
                        ok: false,
                        error: "بيانات الطلب غير مكتملة"
                    }),
                    {
                        status: 400,
                        headers: {
                            ...corsHeaders,
                            "Content-Type":
                                "application/json"
                        }
                    }
                );

            }


            // ==============================
            // إنشاء رسالة Telegram
            // ==============================

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


            // ==============================
            // التحقق من الأسرار
            // ==============================

            if (!env.BOT_TOKEN) {

                throw new Error(
                    "BOT_TOKEN غير موجود في Cloudflare"
                );

            }


            // ==============================
            // إرسال Telegram
            // ==============================

            const chatIds = [
                env.CHAT_ID_1,
                env.CHAT_ID_2
            ].filter(Boolean);


            if (chatIds.length === 0) {

                throw new Error(
                    "لم يتم العثور على CHAT_ID"
                );

            }


            // ==============================
            // إرسال للشخصين
            // ==============================

            for (const chatId of chatIds) {

                const telegramResponse =
                    await fetch(
                        `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
                        {
                            method: "POST",

                            headers: {
                                "Content-Type":
                                    "application/json"
                            },

                            body: JSON.stringify({
                                chat_id: chatId,
                                text: message
                            })
                        }
                    );


                const telegramResult =
                    await telegramResponse.json();


                if (!telegramResult.ok) {

                    throw new Error(
                        telegramResult.description ||
                        "فشل إرسال الرسالة إلى Telegram"
                    );

                }

            }


            // ==============================
            // نجاح
            // ==============================

            return new Response(

                JSON.stringify({
                    ok: true,
                    message:
                        "تم إرسال الطلب بنجاح"
                }),

                {
                    status: 200,

                    headers: {
                        ...corsHeaders,
                        "Content-Type":
                            "application/json"
                    }

                }

            );


        }

        catch (error) {

            console.error(
                "Worker Error:",
                error
            );


            return new Response(

                JSON.stringify({
                    ok: false,
                    error:
                        error.message ||
                        "حدث خطأ في الخادم"
                }),

                {
                    status: 500,

                    headers: {
                        ...corsHeaders,
                        "Content-Type":
                            "application/json"
                    }

                }

            );

        }

    }
};

// Sigma Store Worker
