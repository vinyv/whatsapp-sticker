/**
 * Book Club data access layer
 * Handles all CRUD operations for the book club feature.
 * Data is persisted in a local JSON file with an in-memory cache.
 * @module bookclub
 */

const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { BOOKCLUB_DATA_PATH, BOOKCLUB_GROUP_ID } = require("./config");
const { logger, getBrazilDate } = require("./utils");

// ============================================================
// IN-MEMORY CACHE + MUTEX
// ============================================================

/** @type {object|null} Cached data — loaded once from disk, updated on writes */
let cachedData = null;

/** Mutex lock to serialize all read-modify-write cycles and prevent data loss */
let dataLock = Promise.resolve();

/**
 * Generates a short random hex ID (4 chars)
 * @returns {string} Random 4-char hex string
 */
function genId() {
    return crypto.randomBytes(2).toString("hex");
}

/**
 * Gets the current month as YYYY-MM in UTC-3 (Brazil time)
 * @returns {string} Current month string
 */
function getCurrentMonth() {
    const brDate = getBrazilDate();
    const yyyy = brDate.getFullYear();
    const mm = String(brDate.getMonth() + 1).padStart(2, "0");
    return `${yyyy}-${mm}`;
}

/**
 * Gets today's date as YYYY-MM-DD in UTC-3
 * @returns {string} Today's date string
 */
function getToday() {
    const brDate = getBrazilDate();
    const yyyy = brDate.getFullYear();
    const mm = String(brDate.getMonth() + 1).padStart(2, "0");
    const dd = String(brDate.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * Gets the previous month as YYYY-MM
 * @param {string} currentMonth - Current month in YYYY-MM format
 * @returns {string} Previous month string
 */
function getPreviousMonth(currentMonth) {
    const [year, month] = currentMonth.split("-").map(Number);
    if (month === 1) {
        return `${year - 1}-12`;
    }
    return `${year}-${String(month - 1).padStart(2, "0")}`;
}

/**
 * Checks if a chatId matches the book club group
 * @param {string} chatId - WhatsApp chat ID
 * @returns {boolean}
 */
function isBookClubGroup(chatId) {
    return chatId === BOOKCLUB_GROUP_ID;
}

/**
 * Loads book club data from disk into cache (called once at startup or on first use)
 * @returns {object} Parsed JSON data
 */
function loadDataFromDisk() {
    try {
        const raw = fs.readFileSync(BOOKCLUB_DATA_PATH, "utf-8");
        return JSON.parse(raw);
    } catch (err) {
        logger.warn("Book club data not found or corrupted, creating fresh data");
        const initial = { config: { groupId: "", mes_atual: "" }, livros: [], progresso: {}, names: {} };
        fs.mkdirSync(path.dirname(BOOKCLUB_DATA_PATH), { recursive: true });
        fs.writeFileSync(BOOKCLUB_DATA_PATH, JSON.stringify(initial, null, 2), "utf-8");
        return initial;
    }
}

/**
 * Gets data from the in-memory cache (loads from disk on first access)
 * @returns {object} Book club data
 */
function getData() {
    if (cachedData === null) {
        cachedData = loadDataFromDisk();
    }
    return cachedData;
}

/**
 * Saves data to disk asynchronously (fire-and-forget with error logging)
 * @param {object} data - Data to persist
 */
function saveToDisk(data) {
    fsPromises.writeFile(BOOKCLUB_DATA_PATH, JSON.stringify(data, null, 2), "utf-8")
        .catch(err => logger.error("Failed to save book club data:", err.message));
}

/**
 * Atomically reads data, applies a mutation function, saves, and updates cache.
 * All write operations MUST go through this to prevent race conditions.
 * The lock serializes the entire read→mutate→write cycle so concurrent
 * calls (e.g. addQuote + updateProgress) can never overwrite each other.
 * @param {(data: object) => *} fn - Receives data, mutates it, optionally returns a value
 * @returns {Promise<*>} Whatever fn returns
 */
function withData(fn) {
    const op = dataLock.then(() => {
        const data = getData();
        const result = fn(data);
        saveToDisk(data);
        return result;
    });
    // Lock always resolves for next operation, even if this one fails
    dataLock = op.catch(() => { });
    return op;
}

// ============================================================
// BOOK OPERATIONS
// ============================================================

/**
 * Gets books filtered by month
 * @param {string} month - Month in YYYY-MM format
 * @returns {Array} Filtered books
 */
function getBooksByMonth(month) {
    const data = getData();
    return data.livros.filter((b) => b.mes === month);
}

/**
 * Gets a book by its ID
 * @param {string} id - Book ID
 * @returns {object|null} Book object or null
 */
function getBookById(id) {
    const data = getData();
    return data.livros.find((b) => b.id === id) || null;
}

/**
 * Gets the currently reading book (status === "lendo")
 * @returns {object|null} Book object or null
 */
function getCurrentBook() {
    const data = getData();
    return data.livros.find((b) => b.status === "lendo") || null;
}

/**
 * Adds a new book suggestion
 * @param {string} titulo - Book title
 * @param {string} autor - Author name
 * @param {number} totalPaginas - Total pages
 * @param {string} userId - Suggester's WhatsApp ID
 * @param {object} [meta] - Optional metadata from Google Books
 * @returns {Promise<object>} The created book object
 */
async function addBook(titulo, autor, totalPaginas, userId, meta = {}) {
    return withData((data) => {
        const book = {
            id: genId(),
            titulo,
            autor,
            status: "a_ler",
            mes: "",
            data_inicio: "",
            data_final: "",
            total_paginas: totalPaginas,
            sugerido_por: userId,
            sinopse: meta.sinopse || "",
            capa: meta.capa || "",
            categorias: meta.categorias || [],
            data_publicacao: meta.data_publicacao || "",
            googleBooksId: meta.googleBooksId || "",
            quotes: [],
            reviews: [],
        };
        data.livros.push(book);
        return book;
    });
}

/**
 * Starts reading a book: sets status to "lendo", fills dates
 * @param {string} id - Book ID
 * @param {string} dataFinal - Deadline in YYYY-MM-DD format
 * @returns {Promise<object|null>} Updated book or null if not found
 */
async function startBook(id, dataFinal) {
    return withData((data) => {
        const book = data.livros.find((b) => b.id === id);
        if (!book) return null;

        book.status = "lendo";
        book.data_inicio = getToday();
        book.data_final = dataFinal;
        book.mes = getCurrentMonth();
        data.config.mes_atual = getCurrentMonth();
        return book;
    });
}

/**
 * Marks a book as finished
 * @param {string} id - Book ID
 * @returns {Promise<object|null>} Updated book or null
 */
async function finishBook(id) {
    return withData((data) => {
        const book = data.livros.find((b) => b.id === id);
        if (!book) return null;

        book.status = "lido";
        return book;
    });
}

/**
 * Deletes a book by ID
 * @param {string} id - Book ID
 * @returns {Promise<boolean>} True if deleted
 */
async function deleteBook(id) {
    return withData((data) => {
        const idx = data.livros.findIndex((b) => b.id === id);
        if (idx === -1) return false;

        // Also clean up progress entries for this book
        for (const userId in data.progresso) {
            delete data.progresso[userId][id];
            if (Object.keys(data.progresso[userId]).length === 0) {
                delete data.progresso[userId];
            }
        }

        data.livros.splice(idx, 1);
        return true;
    });
}

/**
 * Edits a field on a book
 * @param {string} id - Book ID
 * @param {string} campo - Field name to edit
 * @param {string} valor - New value
 * @returns {Promise<object|null>} Updated book or null
 */
async function editBook(id, campo, valor) {
    const allowedFields = ["titulo", "autor", "total_paginas", "data_final", "status", "mes"];
    if (!allowedFields.includes(campo)) return null;

    return withData((data) => {
        const book = data.livros.find((b) => b.id === id);
        if (!book) return null;

        if (campo === "total_paginas") {
            book[campo] = parseInt(valor, 10) || 0;
        } else {
            book[campo] = valor;
        }
        return book;
    });
}

/**
 * Extends a book's deadline by N days
 * @param {string} id - Book ID (optional, defaults to current book)
 * @param {number} days - Days to extend (default 7)
 * @returns {Promise<object|null>} Updated book or null
 */
async function extendDeadline(id, days = 7) {
    return withData((data) => {
        let book;
        if (id) {
            book = data.livros.find((b) => b.id === id);
        } else {
            book = data.livros.find((b) => b.status === "lendo");
        }
        if (!book || !book.data_final) return null;

        const date = new Date(book.data_final);
        date.setDate(date.getDate() + days);
        book.data_final = date.toISOString().split("T")[0];
        return book;
    });
}

/**
 * Gets a random book with status "a_ler"
 * @returns {object|null} Random pending book or null
 */
function getRandomPending() {
    const pending = getPendingBooks();
    if (pending.length === 0) return null;
    return pending[Math.floor(Math.random() * pending.length)];
}

// ============================================================
// REVIEW OPERATIONS
// ============================================================

/**
 * Adds a review to a book
 * @param {string} livroId - Book ID
 * @param {string} user - User's WhatsApp ID
 * @param {string} texto - Review text
 * @param {number} nota - Rating (1-5)
 * @returns {Promise<object|null>} Created review or null
 */
async function addReview(livroId, user, texto, nota) {
    return withData((data) => {
        const book = data.livros.find((b) => b.id === livroId);
        if (!book) return null;

        const review = {
            id: genId(),
            user,
            texto,
            nota: Math.min(5, Math.max(1, parseInt(nota, 10) || 5)),
            data: getToday(),
        };
        book.reviews.push(review);
        return review;
    });
}

/**
 * Deletes a review from a book
 * @param {string} livroId - Book ID
 * @param {string} reviewId - Review ID
 * @returns {Promise<boolean>} True if deleted
 */
async function deleteReview(livroId, reviewId) {
    return withData((data) => {
        const book = data.livros.find((b) => b.id === livroId);
        if (!book) return false;

        const idx = book.reviews.findIndex((r) => r.id === reviewId);
        if (idx === -1) return false;

        book.reviews.splice(idx, 1);
        return true;
    });
}

/**
 * Edits a field on a review
 * @param {string} livroId - Book ID
 * @param {string} reviewId - Review ID
 * @param {string} campo - Field to edit
 * @param {string} valor - New value
 * @returns {Promise<object|null>} Updated review or null
 */
async function editReview(livroId, reviewId, campo, valor) {
    const allowedFields = ["texto", "nota"];
    if (!allowedFields.includes(campo)) return null;

    return withData((data) => {
        const book = data.livros.find((b) => b.id === livroId);
        if (!book) return null;

        const review = book.reviews.find((r) => r.id === reviewId);
        if (!review) return null;

        if (campo === "nota") {
            review[campo] = Math.min(5, Math.max(1, parseInt(valor, 10) || 5));
        } else {
            review[campo] = valor;
        }
        return review;
    });
}

// ============================================================
// QUOTE OPERATIONS
// ============================================================

/**
 * Adds a quote to a book
 * @param {string} livroId - Book ID
 * @param {string} user - User's WhatsApp ID
 * @param {string} texto - Quote text
 * @returns {Promise<object|null>} Created quote or null
 */
async function addQuote(livroId, user, texto) {
    return withData((data) => {
        const book = data.livros.find((b) => b.id === livroId);
        if (!book) return null;

        const quote = {
            id: genId(),
            user,
            texto,
            data: getToday(),
        };
        book.quotes.push(quote);
        return quote;
    });
}

// ============================================================
// PROGRESS OPERATIONS
// ============================================================

/**
 * Updates a user's reading progress for a book
 * @param {string} livroId - Book ID
 * @param {string} userId - User's WhatsApp ID
 * @param {number} pagina - Current page number
 * @returns {Promise<{ pagina: number, total: number, percent: number|null }>} Progress info
 */
async function updateProgress(livroId, userId, pagina) {
    return withData((data) => {
        const book = data.livros.find((b) => b.id === livroId);
        if (!book) return null;

        if (!data.progresso[userId]) {
            data.progresso[userId] = {};
        }
        data.progresso[userId][livroId] = pagina;

        const total = book.total_paginas || 0;
        const percent = total > 0 ? Math.min(100, Math.round((pagina / total) * 100)) : null;

        return { pagina, total, percent };
    });
}

/**
 * Gets all users' progress for a specific book
 * @param {string} livroId - Book ID
 * @returns {Array<{ userId: string, pagina: number, percent: number|null }>}
 */
function getBookProgress(livroId) {
    const data = getData();
    const book = data.livros.find((b) => b.id === livroId);
    if (!book) return [];

    const total = book.total_paginas || 0;
    const result = [];

    for (const userId in data.progresso) {
        if (data.progresso[userId][livroId] !== undefined) {
            const pagina = data.progresso[userId][livroId];
            const percent = total > 0 ? Math.min(100, Math.round((pagina / total) * 100)) : null;
            result.push({ userId, pagina, percent });
        }
    }

    return result;
}

/**
 * Gets all books with status "a_ler" (pending)
 * @returns {Array} Pending books
 */
function getPendingBooks() {
    const data = getData();
    return data.livros.filter((b) => b.status === "a_ler");
}

/**
 * Gets all books
 * @returns {Array} All books
 */
function getAllBooks() {
    const data = getData();
    return data.livros;
}

// ============================================================
// NAME OPERATIONS
// ============================================================

/**
 * Gets the display name for a user
 * @param {string} userId - User's WhatsApp ID
 * @returns {string|null} Display name or null
 */
function getName(userId) {
    const data = getData();
    if (!data.names) return null;
    return data.names[userId] || null;
}

/**
 * Sets a display name for a user
 * @param {string} userId - User's WhatsApp ID
 * @param {string} name - Display name
 * @returns {Promise<string>} The saved name
 */
async function setName(userId, name) {
    return withData((data) => {
        if (!data.names) data.names = {};
        data.names[userId] = name;
        return name;
    });
}

module.exports = {
    genId,
    getCurrentMonth,
    getToday,
    getPreviousMonth,
    isBookClubGroup,

    // Books
    getBooksByMonth,
    getBookById,
    getCurrentBook,
    addBook,
    startBook,
    finishBook,
    deleteBook,
    editBook,
    extendDeadline,
    getRandomPending,
    getPendingBooks,
    getAllBooks,

    // Reviews
    addReview,
    deleteReview,
    editReview,

    // Quotes
    addQuote,

    // Progress
    updateProgress,
    getBookProgress,

    // Names
    getName,
    setName,
};
