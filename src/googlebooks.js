/**
 * Google Books API integration for book search.
 * @module googlebooks
 */

const { GOOGLE_BOOKS_API_KEY } = require("./config");
const { logger } = require("./utils");

const API_BASE = "https://www.googleapis.com/books/v1/volumes";

/** Max retry attempts for transient errors (5xx) */
const MAX_RETRIES = 3;

/** Base delay between retries in ms (doubles each attempt) */
const RETRY_BASE_DELAY_MS = 1500;

/** Per-request timeout in ms */
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Fetches a URL with timeout support.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Searches Google Books API for books matching a query.
 * Results are restricted to Portuguese language.
 * Automatically retries on transient errors (5xx) with exponential backoff.
 *
 * @param {string} query - Search query (book title, author, etc.)
 * @param {number} [maxResults=3] - Max results to return (1-3)
 * @returns {Promise<Array<{
 *   googleBooksId: string,
 *   titulo: string,
 *   autor: string,
 *   total_paginas: number,
 *   sinopse: string,
 *   capa: string,
 *   categorias: string[],
 *   data_publicacao: string,
 * }>>}
 */
async function searchBooks(query, maxResults = 3) {
    if (!GOOGLE_BOOKS_API_KEY) {
        throw new Error("GOOGLE_BOOKS_API_KEY não configurada.");
    }

    const params = new URLSearchParams({
        q: query,
        langRestrict: "pt",
        maxResults: String(maxResults),
        printType: "books",
        key: GOOGLE_BOOKS_API_KEY,
    });

    const url = `${API_BASE}?${params}`;
    logger.info(`Google Books search: "${query}"`);

    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);

            if (response.ok) {
                const data = await response.json();
                return parseResults(data);
            }

            // Non-retryable client error (4xx) — fail immediately
            if (response.status >= 400 && response.status < 500) {
                const err = await response.text();
                throw new Error(`Google Books API error ${response.status}: ${err}`);
            }

            // Retryable server error (5xx)
            const errBody = await response.text().catch(() => "");
            lastError = new Error(
                `Google Books API error ${response.status}: ${errBody}`
            );
            logger.warn(
                `Google Books API returned ${response.status} (attempt ${attempt}/${MAX_RETRIES})`
            );
        } catch (err) {
            // AbortError = timeout, TypeError = network failure — both retryable
            if (err.name === "AbortError") {
                lastError = new Error("Google Books API timeout (sem resposta do servidor)");
                logger.warn(`Google Books request timed out (attempt ${attempt}/${MAX_RETRIES})`);
            } else if (err.message?.startsWith("Google Books API error 4")) {
                // Re-throw 4xx errors immediately (not retryable)
                throw err;
            } else {
                lastError = err;
                logger.warn(
                    `Google Books fetch error (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`
                );
            }
        }

        // Wait before retrying (exponential backoff with jitter)
        if (attempt < MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            const jitter = Math.floor(Math.random() * 500);
            await new Promise((r) => setTimeout(r, delay + jitter));
        }
    }

    // All retries exhausted
    throw lastError || new Error("Google Books API indisponível após múltiplas tentativas.");
}

/**
 * Parses Google Books API response into our book format.
 * @param {object} data - Raw API response
 * @returns {Array} Parsed book results
 */
function parseResults(data) {

    if (!data.items || data.items.length === 0) {
        return [];
    }

    return data.items.map((item) => {
        const info = item.volumeInfo || {};

        // Get the best quality thumbnail
        const thumbnail = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || "";
        const capa = thumbnail
            .replace("http://", "https://")
            .replace("&edge=curl", "")
            .replace("zoom=1", "zoom=2");

        return {
            googleBooksId: item.id || "",
            titulo: info.title || "Sem título",
            autor: (info.authors || []).join(", ") || "Desconhecido",
            total_paginas: info.pageCount || 0,
            sinopse: info.description || "",
            capa,
            categorias: info.categories || [],
            data_publicacao: info.publishedDate || "",
        };
    });
}

module.exports = {
    searchBooks,
};
