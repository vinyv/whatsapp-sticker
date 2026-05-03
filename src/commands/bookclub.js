/**
 * Book Club command handlers for WhatsApp.
 * Uses session state machine for multi-step flows.
 * All commands restricted to the book club group.
 * @module commands/bookclub
 */

const {
    isBookClubGroup,
    getCurrentMonth,
    getPreviousMonth,
    getBooksByMonth,
    getBookById,
    getCurrentBook,
    addBook,
    startBook,
    finishBook,
    deleteBook,
    editBook,
    extendDeadline,
    getPendingBooks,
    getAllBooks,
    addReview,
    deleteReview,
    addQuote,
    updateProgress,
    getBookProgress,
    getName,
    setName,
} = require("../bookclub");

const { getSession, setSession, clearSession } = require("../session");
const { searchBooks } = require("../googlebooks");
const { createReactHelper, sendWithBotReaction, logger } = require("../utils");
const { syncBookToNotion, syncAllBooksToNotion, archiveNotionPage } = require("../notion");

/**
 * Fire-and-forget Notion sync for a single book.
 * Never awaited — runs in background, never blocks the bot.
 */
function triggerSync(book) {
    const displayName = getName(book.sugerido_por) || "";
    syncBookToNotion(book, displayName, (uid) => getName(uid) || "").catch(() => { });
}

// ============================================================
// CONSTANTS
// ============================================================

/** Main menu text */
const MENU_TEXT =
    `📚 *Clube do Livro*\n\n` +
    `── Leitura ──\n` +
    `*1.* 📖 Livro atual / Status\n` +
    `*2.* 📝 Deixar review\n` +
    `*3.* 💬 Salvar citação\n` +
    `*4.* 📅 Adiar prazo\n` +
    `*5.* ✅ Encerrar leitura\n\n` +
    `── Gerenciar ──\n` +
    `*6.* ➕ Sugerir livro\n` +
    `*7.* 🎲 Sortear próximo\n` +
    `*8.* ▶️ Iniciar leitura\n` +
    `*9.* 📚 Ver livros lidos\n` +
    `*10.* 🗑️ Deletar livro\n\n` +
    `_Responda com o número da opção_\n` +
    `_ou use /cancelar para sair_`;

/** Maps menu numbers to flow names */
const MENU_ACTIONS = {
    1: "status",
    2: "review",
    3: "quote",
    4: "adiar",
    5: "encerrar",
    6: "sugerir",
    7: "sortear",
    8: "iniciar",
    9: "lidos",
    10: "deletar",
};

// ============================================================
// HELPERS
// ============================================================

function buildProgressBar(percent) {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${percent}%`;
}

function formatDate(dateStr) {
    if (!dateStr) return "—";
    const parts = dateStr.split("-");
    return `${parts[2]}/${parts[1]}`;
}

function formatUser(userId) {
    if (!userId) return "Anônimo";
    // Check stored display name first
    const storedName = getName(userId);
    if (storedName) return storedName;
    // Phone format: 5511999999999@s.whatsapp.net → 5511999999999
    if (userId.includes("@s.whatsapp.net")) {
        return userId.replace("@s.whatsapp.net", "");
    }
    // Fallback: strip anything after @
    return userId.split("@")[0];
}

function formatStars(nota) {
    return "⭐".repeat(nota);
}

function parseDateInput(input) {
    const match = input.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (!match) return null;
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const brDate = new Date(utc + 3600000 * -3);
    const year = brDate.getFullYear();
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getSender(msg) {
    return msg.key.participant || msg.key.remoteJid;
}

// ============================================================
// INSTANT ACTIONS (no session needed)
// ============================================================

async function doStatus(sock, chatId) {
    const book = getCurrentBook();
    if (!book) {
        await sendWithBotReaction(sock, chatId, {
            text: "📖 Nenhum livro sendo lido no momento.\n\nUse /iniciar ou /clube → 8 para começar.",
        });
        return;
    }

    const progressList = getBookProgress(book.id);
    let text = `📊 *Status de Leitura*\n\n📖 *${book.titulo}* — ${book.autor}\n📄 ${book.total_paginas} páginas\n📅 Prazo: ${formatDate(book.data_final)}\n`;

    if (progressList.length === 0) {
        text += `\nNinguém registrou progresso ainda.\nUse /progresso [página] para começar!`;
    } else {
        progressList.sort((a, b) => (b.percent || 0) - (a.percent || 0));
        text += `\n👥 *Progresso individual:*\n`;
        for (const p of progressList) {
            text += `\n@${formatUser(p.userId)}`;
            if (p.percent !== null) {
                text += `\n${buildProgressBar(p.percent)} (pág. ${p.pagina}/${book.total_paginas})`;
            } else {
                text += `\nPágina ${p.pagina}`;
            }
        }
    }

    await sendWithBotReaction(sock, chatId, { text });
}

async function doAdiar(sock, chatId, args) {
    const days = parseInt(args?.trim(), 10) || 7;
    const book = await extendDeadline(null, days);
    if (!book) {
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Nenhum livro sendo lido no momento ou sem data final definida.",
        });
        return;
    }
    triggerSync(book);
    await sendWithBotReaction(sock, chatId, {
        text:
            `📅 *Prazo adiado em ${days} dias!*\n\n` +
            `📖 *${book.titulo}*\n` +
            `📅 Novo prazo: ${formatDate(book.data_final)}`,
    });
}

async function doEncerrar(sock, chatId) {
    const book = getCurrentBook();
    if (!book) {
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Nenhum livro sendo lido no momento.",
        });
        return;
    }
    const finished = await finishBook(book.id);
    if (!finished) {
        await sendWithBotReaction(sock, chatId, { text: "❌ Erro ao encerrar a leitura." });
        return;
    }
    triggerSync(finished);
    await sendWithBotReaction(sock, chatId, {
        text:
            `✅ *Leitura encerrada!*\n\n` +
            `📖 *${book.titulo}* — ${book.autor}\n` +
            `📅 ${formatDate(book.data_inicio)} → ${formatDate(book.data_final)}\n\n` +
            `Não esqueça de deixar sua review com /review\n` +
            `Use /iniciar para começar o próximo livro!`,
    });
}

async function doSortear(sock, chatId) {
    const pending = getPendingBooks();
    if (pending.length === 0) {
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Nenhum livro na fila de leitura! Use /sugerir para adicionar.",
        });
        return;
    }
    const book = pending[Math.floor(Math.random() * pending.length)];
    await sendWithBotReaction(sock, chatId, {
        text:
            `🎲 *Sorteio do Clube!*\n\n` +
            `📖 *${book.titulo}* — ${book.autor}\n` +
            `📄 ${book.total_paginas} páginas\n\n` +
            `Para iniciar a leitura, use /iniciar`,
    });
}

async function doLidos(sock, chatId) {
    const currentMonth = getCurrentMonth();
    const currentBooks = getBooksByMonth(currentMonth).filter(
        (b) => b.status === "lendo" || b.status === "lido"
    );

    if (currentBooks.length > 0) {
        let text = `📖 *Livro(s) do mês (${currentMonth}):*\n`;
        for (const book of currentBooks) {
            const statusEmoji = book.status === "lendo" ? "📗" : "✅";
            text += `\n${statusEmoji} *${book.titulo}* — ${book.autor}`;
            text += `\n   📅 ${formatDate(book.data_inicio)} → ${formatDate(book.data_final)}`;
            text += `\n   📄 ${book.total_paginas} páginas`;
            if (book.reviews.length > 0) {
                text += `\n\n📝 *Reviews (${book.reviews.length}):*`;
                for (const r of book.reviews) {
                    text += `\n   ${formatStars(r.nota)} — @${formatUser(r.user)}`;
                    text += `\n   _"${r.texto}"_`;
                }
            }
            if (book.quotes.length > 0) {
                text += `\n\n💬 *Citações (${book.quotes.length}):*`;
                for (const q of book.quotes) {
                    text += `\n   _"${q.texto}"_ — @${formatUser(q.user)}`;
                }
            }
        }
        await sendWithBotReaction(sock, chatId, { text });
    } else {
        const prevMonth = getPreviousMonth(currentMonth);
        const prevBooks = getBooksByMonth(prevMonth);
        if (prevBooks.length === 0) {
            await sendWithBotReaction(sock, chatId, {
                text: "📚 Nenhum livro encontrado no mês atual nem no anterior.\n\nUse /sugerir para adicionar um livro!",
            });
            return;
        }
        let text = `📚 *Livros do mês anterior (${prevMonth}):*\n`;
        for (const book of prevBooks) {
            const statusEmoji = book.status === "lido" ? "✅" : "📘";
            text += `\n${statusEmoji} *${book.titulo}* — ${book.autor}`;
            if (book.reviews.length > 0) text += ` — ${book.reviews.length} review(s)`;
        }
        await sendWithBotReaction(sock, chatId, { text });
    }
}

async function doProgresso(sock, msg, chatId, args) {
    const pagina = parseInt(args?.trim(), 10);
    if (isNaN(pagina) || pagina < 0) {
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Uso: /progresso [página]\nExemplo: /progresso 45",
        });
        return;
    }
    const book = getCurrentBook();
    if (!book) {
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Nenhum livro sendo lido no momento. Use /iniciar primeiro.",
        });
        return;
    }
    if (book.total_paginas > 0 && pagina > book.total_paginas) {
        await sendWithBotReaction(sock, chatId, {
            text: `❌ O livro *${book.titulo}* tem apenas ${book.total_paginas} páginas.`,
        });
        return;
    }
    const userId = getSender(msg);
    const progress = await updateProgress(book.id, userId, pagina);
    triggerSync(book);
    let text = `📊 *Progresso atualizado!*\n\n📖 ${book.titulo}\n📄 Página ${progress.pagina}`;
    if (progress.total > 0) {
        text += ` de ${progress.total}`;
        text += `\n${buildProgressBar(progress.percent)}`;
    }
    await sendWithBotReaction(sock, chatId, { text });
}

async function doQuoteDirect(sock, msg, chatId, args) {
    if (!args || !args.trim()) {
        // No text provided, start quote session
        return false;
    }
    const book = getCurrentBook();
    if (!book) {
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Nenhum livro sendo lido no momento. Use /iniciar primeiro.",
        });
        return true;
    }
    const userId = getSender(msg);
    const quote = await addQuote(book.id, userId, args.trim());
    triggerSync(book);
    await sendWithBotReaction(sock, chatId, {
        text: `💬 *Citação salva!*\n\n📖 ${book.titulo}\n_"${quote.texto}"_`,
    });
    return true;
}

// ============================================================
// MULTI-STEP FLOW STARTERS
// ============================================================

async function startIniciar(sock, chatId, userId) {
    const currentBook = getCurrentBook();
    if (currentBook) {
        await sendWithBotReaction(sock, chatId, {
            text:
                `❌ Já existe um livro em leitura!\n\n` +
                `📖 *${currentBook.titulo}* — ${currentBook.autor}\n\n` +
                `Use /encerrar para finalizar a leitura atual.`,
        });
        return;
    }

    const pending = getPendingBooks();
    if (pending.length === 0) {
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Nenhum livro na fila de leitura!\nUse /sugerir para adicionar um livro primeiro.",
        });
        return;
    }

    setSession(userId, {
        flow: "iniciar",
        step: "pick_book",
        data: { books: pending },
    });

    let text = `📚 *Livros disponíveis para leitura:*\n`;
    pending.forEach((book, i) => {
        text += `\n*${i + 1}.* 📖 ${book.titulo} — ${book.autor} (${book.total_paginas} pág.)`;
    });
    text += `\n\n_Responda com o número do livro:_`;
    await sendWithBotReaction(sock, chatId, { text });
}

async function startReview(sock, chatId, userId) {
    const currentMonth = getCurrentMonth();
    const prevMonth = getPreviousMonth(currentMonth);

    const currentBooks = getBooksByMonth(currentMonth).filter(
        (b) => b.status === "lendo" || b.status === "lido"
    );
    const prevBooks = getBooksByMonth(prevMonth).filter(
        (b) => b.status === "lendo" || b.status === "lido"
    );

    const seen = new Set();
    const reviewable = [];
    const current = getCurrentBook();
    if (current) {
        seen.add(current.id);
        reviewable.push(current);
    }
    for (const book of [...currentBooks, ...prevBooks]) {
        if (!seen.has(book.id)) {
            seen.add(book.id);
            reviewable.push(book);
        }
    }

    if (reviewable.length === 0) {
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Nenhum livro para avaliar! Comece uma leitura com /iniciar primeiro.",
        });
        return;
    }

    setSession(userId, {
        flow: "review",
        step: "pick_book",
        data: { books: reviewable },
    });

    let text = `📝 *Qual livro você quer avaliar?*\n`;
    reviewable.forEach((book, i) => {
        const statusEmoji = book.status === "lendo" ? "📗" : "✅";
        const reviewCount = book.reviews.length > 0 ? ` (${book.reviews.length} reviews)` : "";
        text += `\n*${i + 1}.* ${statusEmoji} ${book.titulo} — ${book.autor}${reviewCount}`;
    });
    text += `\n\n_Responda com o número do livro:_`;
    await sendWithBotReaction(sock, chatId, { text });
}

async function startSugerir(sock, chatId, userId, query) {
    if (!query || !query.trim()) {
        // No query provided (e.g. from menu) — prompt for book name
        setSession(userId, {
            flow: "sugerir",
            step: "ask_name",
            data: {},
        });
        await sendWithBotReaction(sock, chatId, {
            text: `📚 *Sugerir um livro*\n\n_Qual o nome do livro?_`,
        });
        return;
    }

    await sendWithBotReaction(sock, chatId, {
        text: `🔍 Buscando _"${query.trim()}"_...`,
    });

    try {
        const results = await searchBooks(query.trim(), 3);

        if (results.length === 0) {
            await sendWithBotReaction(sock, chatId, {
                text: `❌ Nenhum resultado encontrado para _"${query.trim()}"_.\nTente outro título.`,
            });
            return;
        }

        setSession(userId, {
            flow: "sugerir",
            step: "pick_result",
            data: { results },
        });

        let text = `📚 *Resultados para "${query.trim()}":*\n`;
        results.forEach((r, i) => {
            const pages = r.total_paginas > 0 ? `${r.total_paginas} pág.` : "pág. desconhecidas";
            const sinopse = r.sinopse
                ? r.sinopse.substring(0, 100) + (r.sinopse.length > 100 ? "..." : "")
                : "_Sem sinopse_";
            text += `\n*${i + 1}.* 📖 *${r.titulo}*`;
            text += `\n   ✍️ ${r.autor} · ${pages}`;
            text += `\n   ${sinopse}\n`;
        });
        text += `\n_Responda com o número do livro:_`;
        await sendWithBotReaction(sock, chatId, { text });
    } catch (error) {
        logger.error("Google Books search failed:", error.message);
        await sendWithBotReaction(sock, chatId, {
            text: `❌ Erro ao buscar: ${error.message}`,
        });
    }
}

async function startQuote(sock, chatId, userId) {
    const book = getCurrentBook();
    if (!book) {
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Nenhum livro sendo lido no momento. Use /iniciar primeiro.",
        });
        return;
    }
    setSession(userId, {
        flow: "quote",
        step: "text",
        data: { bookId: book.id, bookTitle: book.titulo },
    });
    await sendWithBotReaction(sock, chatId, {
        text: `💬 *Salvar citação*\n\n📖 ${book.titulo}\n\n_Digite o trecho que deseja salvar:_`,
    });
}

async function startDeletar(sock, chatId, userId) {
    const allBooks = getAllBooks();
    if (allBooks.length === 0) {
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Nenhum livro cadastrado.",
        });
        return;
    }

    setSession(userId, {
        flow: "deletar",
        step: "pick_book",
        data: { books: allBooks },
    });

    let text = `🗑️ *Deletar livro*\n\n_Qual livro deseja deletar?_\n`;
    allBooks.forEach((book, i) => {
        const statusMap = { a_ler: "📋", lendo: "📗", lido: "✅" };
        const emoji = statusMap[book.status] || "📘";
        text += `\n*${i + 1}.* ${emoji} ${book.titulo} — ${book.autor}`;
    });
    text += `\n\n_Responda com o número:_`;
    await sendWithBotReaction(sock, chatId, { text });
}

// ============================================================
// SESSION STEP HANDLERS
// ============================================================

/**
 * Handles the next step of an active session
 * @returns {boolean} True if handled
 */
async function handleSessionStep(sock, msg, chatId, userId, text) {
    const session = getSession(userId);
    if (!session) return false;

    const { flow, step, data } = session;

    try {
        switch (flow) {
            case "menu":
                return await handleMenuStep(sock, msg, chatId, userId, text, step, data);
            case "iniciar":
                return await handleIniciarStep(sock, msg, chatId, userId, text, step, data);
            case "review":
                return await handleReviewStep(sock, msg, chatId, userId, text, step, data);
            case "sugerir":
                return await handleSugerirStep(sock, msg, chatId, userId, text, step, data);
            case "quote":
                return await handleQuoteStep(sock, msg, chatId, userId, text, step, data);
            case "deletar":
                return await handleDeletarStep(sock, msg, chatId, userId, text, step, data);
            default:
                clearSession(userId);
                return false;
        }
    } catch (error) {
        logger.error(`Session error (${flow}/${step}):`, error.message);
        clearSession(userId);
        await sendWithBotReaction(sock, chatId, {
            text: `❌ Erro: ${error.message}\nSessão encerrada.`,
        });
        return true;
    }
}

// --- Menu flow ---
async function handleMenuStep(sock, msg, chatId, userId, text) {
    const num = parseInt(text.trim(), 10);
    const action = MENU_ACTIONS[num];

    if (!action) {
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Opção inválida. Responda com um número de 1 a 10.\nOu use /cancelar para sair.",
        });
        return true;
    }

    clearSession(userId);
    await dispatchAction(sock, msg, chatId, userId, action);
    return true;
}

// --- Iniciar flow ---
async function handleIniciarStep(sock, msg, chatId, userId, text, step, data) {
    if (step === "pick_book") {
        const num = parseInt(text.trim(), 10);
        if (isNaN(num) || num < 1 || num > data.books.length) {
            await sendWithBotReaction(sock, chatId, {
                text: `❌ Responda com um número de 1 a ${data.books.length}.`,
            });
            return true;
        }

        const selected = data.books[num - 1];
        setSession(userId, {
            flow: "iniciar",
            step: "pick_date",
            data: { ...data, bookId: selected.id, bookTitle: selected.titulo },
        });

        await sendWithBotReaction(sock, chatId, {
            text: `📖 *${selected.titulo}*\n\n📅 _Qual a data final de leitura? (dd/mm)_\n_Exemplo: 15/03_`,
        });
        return true;
    }

    if (step === "pick_date") {
        const dataFinal = parseDateInput(text.trim());
        if (!dataFinal) {
            await sendWithBotReaction(sock, chatId, {
                text: "❌ Data inválida. Use o formato dd/mm.\nExemplo: 15/03",
            });
            return true;
        }

        // Double-check no book is being read
        const currentBook = getCurrentBook();
        if (currentBook) {
            clearSession(userId);
            await sendWithBotReaction(sock, chatId, {
                text: `❌ Já existe um livro em leitura: *${currentBook.titulo}*\nUse /encerrar primeiro.`,
            });
            return true;
        }

        const book = await startBook(data.bookId, dataFinal);
        clearSession(userId);

        if (!book) {
            await sendWithBotReaction(sock, chatId, { text: "❌ Erro ao iniciar o livro." });
            return true;
        }
        triggerSync(book);

        const sentMsg = await sendWithBotReaction(sock, chatId, {
            text:
                `📗 *Leitura iniciada!*\n\n` +
                `📖 *${book.titulo}* — ${book.autor}\n` +
                `📅 Início: ${formatDate(book.data_inicio)}\n` +
                `📅 Prazo: ${formatDate(book.data_final)}\n` +
                `📄 ${book.total_paginas} páginas\n\n` +
                `Use /progresso [página] para registrar seu avanço!`,
        });

        // Pin the message until the due date
        try {
            const dueDate = new Date(dataFinal + "T23:59:59-03:00");
            const diffMs = dueDate.getTime() - Date.now();
            // Pick the smallest WhatsApp pin duration that covers the time
            const PIN_24H = 86400;
            const PIN_7D = 604800;
            const PIN_30D = 2592000;
            const diffSec = Math.ceil(diffMs / 1000);
            let pinTime = PIN_30D;
            if (diffSec <= PIN_24H) pinTime = PIN_24H;
            else if (diffSec <= PIN_7D) pinTime = PIN_7D;

            await sock.sendMessage(chatId, {
                pin: { type: 1, time: pinTime, key: sentMsg.key },
            });
        } catch (pinErr) {
            logger.warn("Failed to pin book message:", pinErr.message);
        }
        return true;
    }

    return false;
}

// --- Review flow ---
async function handleReviewStep(sock, msg, chatId, userId, text, step, data) {
    if (step === "pick_book") {
        const num = parseInt(text.trim(), 10);
        if (isNaN(num) || num < 1 || num > data.books.length) {
            await sendWithBotReaction(sock, chatId, {
                text: `❌ Responda com um número de 1 a ${data.books.length}.`,
            });
            return true;
        }

        const selected = data.books[num - 1];
        setSession(userId, {
            flow: "review",
            step: "pick_rating",
            data: { ...data, bookId: selected.id, bookTitle: selected.titulo },
        });

        await sendWithBotReaction(sock, chatId, {
            text: `📖 *${selected.titulo}*\n\n⭐ _Qual sua nota? (1 a 5)_`,
        });
        return true;
    }

    if (step === "pick_rating") {
        const nota = parseInt(text.trim(), 10);
        if (isNaN(nota) || nota < 1 || nota > 5) {
            await sendWithBotReaction(sock, chatId, {
                text: "❌ A nota deve ser um número de 1 a 5.",
            });
            return true;
        }

        setSession(userId, {
            flow: "review",
            step: "write_text",
            data: { ...data, nota },
        });

        await sendWithBotReaction(sock, chatId, {
            text: `${formatStars(nota)}\n\n📝 _Agora escreva sua review:_`,
        });
        return true;
    }

    if (step === "write_text") {
        const reviewText = text.trim();
        if (!reviewText) {
            await sendWithBotReaction(sock, chatId, {
                text: "❌ A review não pode ser vazia.",
            });
            return true;
        }

        const senderId = getSender(msg);
        const review = await addReview(data.bookId, senderId, reviewText, data.nota);
        clearSession(userId);

        if (!review) {
            await sendWithBotReaction(sock, chatId, {
                text: "❌ Erro ao salvar a review.",
            });
            return true;
        }
        const reviewBook = getBookById(data.bookId);
        if (reviewBook) triggerSync(reviewBook);

        await sendWithBotReaction(sock, chatId, {
            text:
                `📝 *Review adicionada!*\n\n` +
                `📖 ${data.bookTitle}\n` +
                `${formatStars(review.nota)}\n` +
                `_"${review.texto}"_`,
        });
        return true;
    }

    return false;
}

// --- Sugerir flow ---
async function handleSugerirStep(sock, msg, chatId, userId, text, step, data) {
    if (step === "ask_name") {
        const query = text.trim();
        if (!query) {
            await sendWithBotReaction(sock, chatId, { text: "❌ O nome do livro não pode ser vazio." });
            return true;
        }
        // Clear session and run the search (startSugerir will set a new session)
        clearSession(userId);
        await startSugerir(sock, chatId, userId, query);
        return true;
    }

    if (step === "pick_result") {
        const num = parseInt(text.trim(), 10);
        if (isNaN(num) || num < 1 || num > data.results.length) {
            await sendWithBotReaction(sock, chatId, {
                text: `❌ Responda com um número de 1 a ${data.results.length}.`,
            });
            return true;
        }

        const selected = data.results[num - 1];
        const senderId = getSender(msg);
        const book = await addBook(
            selected.titulo,
            selected.autor,
            selected.total_paginas,
            senderId,
            {
                sinopse: selected.sinopse,
                capa: selected.capa,
                categorias: selected.categorias,
                data_publicacao: selected.data_publicacao,
                googleBooksId: selected.googleBooksId,
            }
        );
        clearSession(userId);
        triggerSync(book);

        // Send cover image if available
        if (selected.capa) {
            try {
                await sock.sendMessage(chatId, {
                    image: { url: selected.capa },
                    caption:
                        `📚 *Livro adicionado!*\n\n` +
                        `📖 *${book.titulo}*\n` +
                        `✍️ ${book.autor}\n` +
                        `📄 ${book.total_paginas || "?"} páginas\n` +
                        (book.categorias.length > 0 ? `🏷️ ${book.categorias.join(", ")}\n` : "") +
                        `\n📊 Status: Esperando leitura` +
                        (book.sinopse ? `\n\n📝 *Sinopse:*\n${book.sinopse.substring(0, 500)}${book.sinopse.length > 500 ? "..." : ""}` : ""),
                });
            } catch (imgErr) {
                logger.warn("Failed to send cover image:", imgErr.message);
                // Fallback to text-only
                await sendWithBotReaction(sock, chatId, {
                    text:
                        `📚 *Livro adicionado!*\n\n` +
                        `📖 *${book.titulo}*\n` +
                        `✍️ ${book.autor}\n` +
                        `📄 ${book.total_paginas || "?"} páginas\n` +
                        `📊 Status: Esperando leitura`,
                });
            }
        } else {
            await sendWithBotReaction(sock, chatId, {
                text:
                    `📚 *Livro adicionado!*\n\n` +
                    `📖 *${book.titulo}*\n` +
                    `✍️ ${book.autor}\n` +
                    `📄 ${book.total_paginas || "?"} páginas\n` +
                    `📊 Status: Esperando leitura`,
            });
        }
        return true;
    }

    return false;
}

// --- Quote flow ---
async function handleQuoteStep(sock, msg, chatId, userId, text, step, data) {
    if (step === "text") {
        const quoteText = text.trim();
        if (!quoteText) {
            await sendWithBotReaction(sock, chatId, { text: "❌ A citação não pode ser vazia." });
            return true;
        }

        const senderId = getSender(msg);
        const quote = await addQuote(data.bookId, senderId, quoteText);
        clearSession(userId);
        const quoteBook = getBookById(data.bookId);
        if (quoteBook) triggerSync(quoteBook);

        await sendWithBotReaction(sock, chatId, {
            text: `💬 *Citação salva!*\n\n📖 ${data.bookTitle}\n_"${quote.texto}"_`,
        });
        return true;
    }

    return false;
}

// --- Deletar flow ---
async function handleDeletarStep(sock, msg, chatId, userId, text, step, data) {
    if (step === "pick_book") {
        const num = parseInt(text.trim(), 10);
        if (isNaN(num) || num < 1 || num > data.books.length) {
            await sendWithBotReaction(sock, chatId, {
                text: `❌ Responda com um número de 1 a ${data.books.length}.`,
            });
            return true;
        }

        const selected = data.books[num - 1];
        setSession(userId, {
            flow: "deletar",
            step: "confirm",
            data: { ...data, bookId: selected.id, bookTitle: selected.titulo },
        });

        await sendWithBotReaction(sock, chatId, {
            text:
                `⚠️ *Tem certeza que deseja deletar?*\n\n` +
                `📖 *${selected.titulo}* — ${selected.autor}\n\n` +
                `_Responda *sim* para confirmar ou /cancelar para desistir._`,
        });
        return true;
    }

    if (step === "confirm") {
        const answer = text.trim().toLowerCase();
        if (answer !== "sim" && answer !== "s") {
            clearSession(userId);
            await sendWithBotReaction(sock, chatId, { text: "❌ Operação cancelada." });
            return true;
        }

        const deleted = await deleteBook(data.bookId);
        clearSession(userId);

        if (!deleted) {
            await sendWithBotReaction(sock, chatId, { text: "❌ Erro ao deletar o livro." });
            return true;
        }

        // Archive from Notion in background
        archiveNotionPage(data.bookTitle).catch(() => { });

        await sendWithBotReaction(sock, chatId, {
            text: `🗑️ Livro *${data.bookTitle}* deletado com sucesso!`,
        });
        return true;
    }

    return false;
}

// ============================================================
// ACTION DISPATCHER
// ============================================================

/**
 * Dispatches a named action (from menu or direct command)
 */
async function dispatchAction(sock, msg, chatId, userId, action, args) {
    switch (action) {
        case "status":
            await doStatus(sock, chatId);
            break;
        case "review":
            await startReview(sock, chatId, userId);
            break;
        case "quote":
            if (args && args.trim()) {
                await doQuoteDirect(sock, msg, chatId, args);
            } else {
                await startQuote(sock, chatId, userId);
            }
            break;
        case "adiar":
            await doAdiar(sock, chatId, args);
            break;
        case "encerrar":
            await doEncerrar(sock, chatId);
            break;
        case "sugerir":
            await startSugerir(sock, chatId, userId, args);
            break;
        case "sortear":
            await doSortear(sock, chatId);
            break;
        case "iniciar":
            await startIniciar(sock, chatId, userId);
            break;
        case "lidos":
            await doLidos(sock, chatId);
            break;
        case "deletar":
            await startDeletar(sock, chatId, userId);
            break;
    }
}

// ============================================================
// PATTERN MATCHING & MAIN ROUTER
// ============================================================

const BOOKCLUB_PATTERN =
    /^\/(clube|iniciar|sugerir|review|quote|progresso|sortear|adiar|status|lidos|encerrar|deletar|cancelar|nome|ajuda|sync|groupid)(?:\s+(.*))?$/i;

function matchBookClubCommand(text) {
    return text.match(BOOKCLUB_PATTERN);
}

/**
 * Main book club command handler
 */
async function handleBookClubCommand(sock, msg, chatId, match) {
    const command = match[1].toLowerCase();
    const args = match[2] || "";
    const userId = getSender(msg);

    // /groupid works in any chat
    if (command === "groupid") {
        await sendWithBotReaction(sock, chatId, { text: `🆔 *Group ID:*\n\`${chatId}\`` });
        return true;
    }

    // /cancelar works in any chat if user has a session
    if (command === "cancelar") {
        if (clearSession(userId)) {
            await sendWithBotReaction(sock, chatId, { text: "✅ Operação cancelada." });
        }
        return true;
    }

    // /nome works in any chat — links a display name to the sender's ID
    if (command === "nome") {
        const name = args.trim();
        if (!name) {
            const current = getName(userId);
            await sendWithBotReaction(sock, chatId, {
                text: current
                    ? `👤 Seu nome atual: *${current}*\n\nUse /nome [novo nome] para alterar.`
                    : `👤 Nenhum nome definido.\n\nUse /nome [seu nome] para definir.`,
            });
            return true;
        }
        await setName(userId, name);
        await sendWithBotReaction(sock, chatId, {
            text: `✅ Nome definido: *${name}*`,
        });
        return true;
    }

    // /ajuda works in any chat — shows all bot commands
    if (command === "ajuda") {
        await sendWithBotReaction(sock, chatId, {
            text:
                `🤖 *Comandos do Bot*\n\n` +
                `── Sticker ──\n` +
                `🖼️ /s — Converter imagem/vídeo em sticker\n` +
                `_(envie como legenda ou responda a uma mídia)_\n\n` +
                `── Download ──\n` +
                `📥 /d [url] — Baixar vídeo\n` +
                `🎵 /da [url] — Baixar áudio (MP3)\n` +
                `🖼️ /ds [url] — Baixar e converter em sticker\n` +
                `_(sem url = pesquisa no YouTube)_\n\n` +
                `── Clube do Livro ──\n` +
                `📚 /clube — Menu principal (todas as opções)\n` +
                `📊 /progresso [pág] — Registrar progresso\n` +
                `📖 /status — Ver status do livro atual\n` +
                `👤 /nome [nome] — Definir seu nome\n` +
                `_Use /clube para ver todas as opções do clube._\n\n` +
                `❌ /cancelar — Cancelar fluxo atual\n` +
                `❓ /ajuda — Esta mensagem`,
        });
        return true;
    }

    // /sync — syncs all books to Notion
    if (command === "sync") {
        if (!isBookClubGroup(chatId)) {
            await sendWithBotReaction(sock, chatId, {
                text: "❌ Este comando só funciona no grupo do Clube do Livro.",
            });
            return true;
        }
        await sendWithBotReaction(sock, chatId, {
            text: "🔄 Sincronizando com o Notion...",
        });
        const books = getAllBooks();
        syncAllBooksToNotion(books, (uid) => getName(uid) || "").then((result) => {
            sendWithBotReaction(sock, chatId, {
                text:
                    `✅ *Sincronização concluída!*\n\n` +
                    `📗 ${result.created} criados\n` +
                    `📝 ${result.updated} atualizados\n` +
                    (result.failed > 0 ? `❌ ${result.failed} com erro` : ""),
            });
        }).catch((err) => {
            logger.error("Full sync failed:", err.message);
            sendWithBotReaction(sock, chatId, {
                text: "❌ Erro na sincronização. Tente novamente.",
            });
        });
        return true;
    }

    // Group lock — all remaining commands only work in the book club group
    if (!isBookClubGroup(chatId)) {
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Este comando só funciona no grupo do Clube do Livro.",
        });
        return true;
    }

    try {
        // Clear any existing session when starting a new command
        clearSession(userId);

        if (command === "clube") {
            // Show main menu and set menu session
            setSession(userId, { flow: "menu", step: "pick", data: {} });
            await sendWithBotReaction(sock, chatId, { text: MENU_TEXT });
        } else if (command === "progresso") {
            // Progresso is always direct (quick shortcut)
            await doProgresso(sock, msg, chatId, args);
        } else {
            // All other commands dispatch through the action system
            await dispatchAction(sock, msg, chatId, userId, command, args);
        }
    } catch (error) {
        logger.error(`Book club error (${command}):`, error.message);
        clearSession(userId);
        await sendWithBotReaction(sock, chatId, {
            text: `❌ Erro ao executar /${command}. Tente novamente.`,
        });
    }

    return true;
}

module.exports = {
    matchBookClubCommand,
    handleBookClubCommand,
    handleSessionStep,
};
