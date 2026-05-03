/**
 * Google Books API integration for book search.
 * @module googlebooks
 */

const { GOOGLE_BOOKS_API_KEY } = require("./config");
const { logger } = require("./utils");

const API_BASE = "https://www.googleapis.com/books/v1/volumes";

/**
 * Searches Google Books API for books matching a query.
 * Results are restricted to Portuguese language.
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

    const response = await fetch(url);
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Google Books API error ${response.status}: ${err}`);
    }

    const data = await response.json();

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
