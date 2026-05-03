/**
 * Notion API sync for book club data.
 * Runs async — never blocks the bot's message handling.
 * @module notion
 */

const { logger } = require("./utils");
const { getBookProgress } = require("./bookclub");
const { NOTION_API_KEY, NOTION_DB_ID } = require("./config");

const NOTION_VERSION = "2022-06-28";
const BASE_URL = "https://api.notion.com/v1";

function getHeaders() {
    return {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    };
}

// ============================================================
// NOTION API HELPERS
// ============================================================

async function notionRequest(method, path, body = null) {
    if (!NOTION_API_KEY) {
        throw new Error("NOTION_API_KEY not configured in .env");
    }

    const opts = { method, headers: getHeaders() };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE_URL}${path}`, opts);
    const data = await res.json();

    if (!res.ok) {
        throw new Error(`Notion API ${res.status}: ${data.message || JSON.stringify(data)}`);
    }
    return data;
}

/**
 * Queries the database for a page matching a book's local ID (stored in title).
 * Uses the book title + author to find matching pages.
 * @param {object} book - Book object from local data
 * @returns {Promise<string|null>} Notion page ID if found
 */
async function findExistingPage(book) {
    const result = await notionRequest("POST", `/databases/${NOTION_DB_ID}/query`, {
        filter: {
            property: "Name",
            title: { equals: book.titulo },
        },
        page_size: 1,
    });

    if (result.results && result.results.length > 0) {
        return result.results[0].id;
    }
    return null;
}

// ============================================================
// PROPERTY BUILDERS
// ============================================================

function buildProperties(book, displayName) {
    const props = {
        Name: {
            title: [{ text: { content: book.titulo || "" } }],
        },
        Autor: {
            rich_text: [{ text: { content: book.autor || "" } }],
        },
        Páginas: {
            number: book.total_paginas || null,
        },
        Status: {
            select: { name: mapStatus(book.status) },
        },
        "Sugerido por": {
            rich_text: [{ text: { content: displayName || "" } }],
        },
    };

    // Optional fields — only include if data exists
    if (book.mes) {
        props["Mês"] = { select: { name: book.mes } };
    }
    if (book.data_inicio) {
        props["Início"] = { date: { start: book.data_inicio } };
    }
    if (book.data_final) {
        props["Fim"] = { date: { start: book.data_final } };
    }
    if (book.categorias && book.categorias.length > 0) {
        props["Categorias"] = {
            multi_select: book.categorias.map((c) => ({ name: c })),
        };
    }
    if (book.data_publicacao) {
        props["Publicação"] = {
            rich_text: [{ text: { content: book.data_publicacao } }],
        };
    }

    return props;
}

function mapStatus(status) {
    const map = {
        a_ler: "A ler",
        lendo: "Lendo",
        lido: "Lido",
    };
    return map[status] || status;
}

/**
 * Builds Notion page children blocks (synopsis, progress, reviews, quotes)
 * @param {object} book
 * @param {function} getDisplayName - (userId) => name
 * @param {Array<{userId: string, pagina: number, percent: number|null}>} [progress]
 */
function buildContent(book, getDisplayName, progress) {
    const children = [];

    if (book.sinopse) {
        children.push({
            object: "block",
            type: "heading_2",
            heading_2: {
                rich_text: [{ text: { content: "Sinopse" } }],
            },
        });
        // Notion blocks have a 2000 char limit — split if needed
        const chunks = splitText(book.sinopse, 2000);
        for (const chunk of chunks) {
            children.push({
                object: "block",
                type: "paragraph",
                paragraph: {
                    rich_text: [{ text: { content: chunk } }],
                },
            });
        }
    }

    if (progress && progress.length > 0) {
        children.push({
            object: "block",
            type: "heading_2",
            heading_2: {
                rich_text: [{ text: { content: "Progresso" } }],
            },
        });
        for (const p of progress) {
            const name = getDisplayName(p.userId) || "Anônimo";
            const total = book.total_paginas || 0;
            const pctText = p.percent !== null ? ` (${p.percent}%)` : "";
            const pageText = total > 0 ? `pág. ${p.pagina}/${total}` : `pág. ${p.pagina}`;
            children.push({
                object: "block",
                type: "bulleted_list_item",
                bulleted_list_item: {
                    rich_text: [{ text: { content: `${name} — ${pageText}${pctText}` } }],
                },
            });
        }
    }

    if (book.reviews && book.reviews.length > 0) {
        children.push({
            object: "block",
            type: "heading_2",
            heading_2: {
                rich_text: [{ text: { content: "Reviews" } }],
            },
        });
        for (const review of book.reviews) {
            children.push({
                object: "block",
                type: "quote",
                quote: {
                    rich_text: [
                        {
                            text: {
                                content: `${"⭐".repeat(review.nota)} — ${getDisplayName(review.user) || "Anônimo"}\n${review.texto}`,
                            },
                        },
                    ],
                },
            });
        }
    }

    if (book.quotes && book.quotes.length > 0) {
        children.push({
            object: "block",
            type: "heading_2",
            heading_2: {
                rich_text: [{ text: { content: "Citações" } }],
            },
        });
        for (const quote of book.quotes) {
            children.push({
                object: "block",
                type: "quote",
                quote: {
                    rich_text: [{ text: { content: `"${quote.texto}" — ${getDisplayName(quote.user) || "Anônimo"}` } }],
                },
            });
        }
    }

    return children;
}

function splitText(text, maxLen) {
    const chunks = [];
    for (let i = 0; i < text.length; i += maxLen) {
        chunks.push(text.substring(i, i + maxLen));
    }
    return chunks;
}

// ============================================================
// SYNC OPERATIONS
// ============================================================

/**
 * Creates a new page in the Notion database for a book.
 */
async function createPage(book, displayName, getDisplayName) {
    const progress = getBookProgress(book.id);
    const body = {
        parent: { database_id: NOTION_DB_ID },
        properties: buildProperties(book, displayName),
        children: buildContent(book, getDisplayName || (() => ""), progress),
    };

    // Add cover image if available
    if (book.capa) {
        body.cover = {
            type: "external",
            external: { url: book.capa },
        };
    }

    const page = await notionRequest("POST", "/pages", body);
    logger.info(`Notion: Created page for "${book.titulo}" (${page.id})`);
    return page.id;
}

/**
 * Updates an existing Notion page with current book data.
 * Also replaces all children blocks (synopsis, reviews, quotes).
 */
async function updatePage(pageId, book, displayName, getDisplayName) {
    const body = {
        properties: buildProperties(book, displayName),
    };

    // Update cover if available
    if (book.capa) {
        body.cover = {
            type: "external",
            external: { url: book.capa },
        };
    }

    await notionRequest("PATCH", `/pages/${pageId}`, body);

    // Replace children: delete existing blocks, then append new ones
    try {
        const existing = await notionRequest("GET", `/blocks/${pageId}/children?page_size=100`);
        if (existing.results && existing.results.length > 0) {
            for (const block of existing.results) {
                await notionRequest("DELETE", `/blocks/${block.id}`);
            }
        }

        const progress = getBookProgress(book.id);
        const children = buildContent(book, getDisplayName || (() => ""), progress);
        if (children.length > 0) {
            await notionRequest("PATCH", `/blocks/${pageId}/children`, { children });
        }
    } catch (childErr) {
        logger.warn(`Notion: Failed to update children for "${book.titulo}":`, childErr.message);
    }

    logger.info(`Notion: Updated page for "${book.titulo}" (${pageId})`);
}

/**
 * Archives (soft-deletes) a Notion page matching a book title.
 */
async function archiveNotionPage(bookTitle) {
    try {
        const result = await notionRequest("POST", `/databases/${NOTION_DB_ID}/query`, {
            filter: {
                property: "Name",
                title: { equals: bookTitle },
            },
            page_size: 1,
        });

        if (result.results && result.results.length > 0) {
            const pageId = result.results[0].id;
            await notionRequest("PATCH", `/pages/${pageId}`, { archived: true });
            logger.info(`Notion: Archived page for "${bookTitle}" (${pageId})`);
        }
    } catch (error) {
        logger.error(`Notion archive failed for "${bookTitle}":`, error.message);
    }
}

/**
 * Syncs a single book to Notion — creates or updates as needed.
 * This is the main entry point, designed to be called fire-and-forget.
 * @param {function} [getDisplayName] - (userId) => name lookup
 */
async function syncBookToNotion(book, displayName, getDisplayName) {
    try {
        const existingPageId = await findExistingPage(book);

        if (existingPageId) {
            await updatePage(existingPageId, book, displayName, getDisplayName);
        } else {
            await createPage(book, displayName, getDisplayName);
        }
    } catch (error) {
        logger.error(`Notion sync failed for "${book.titulo}":`, error.message);
    }
}

/**
 * Syncs ALL books to Notion. Useful for initial migration or manual resync.
 * Processes sequentially to avoid rate limits.
 */
async function syncAllBooksToNotion(books, getDisplayName) {
    logger.info(`Notion: Starting full sync of ${books.length} books...`);
    let created = 0;
    let updated = 0;
    let failed = 0;

    for (const book of books) {
        try {
            const displayName = getDisplayName(book.sugerido_por);
            const existingPageId = await findExistingPage(book);

            if (existingPageId) {
                await updatePage(existingPageId, book, displayName, getDisplayName);
                updated++;
            } else {
                await createPage(book, displayName, getDisplayName);
                created++;
            }

            // Small delay to respect rate limits (3 req/sec for Notion)
            await new Promise((r) => setTimeout(r, 350));
        } catch (error) {
            logger.error(`Notion sync failed for "${book.titulo}":`, error.message);
            failed++;
        }
    }

    logger.info(`Notion: Full sync done — ${created} created, ${updated} updated, ${failed} failed`);
    return { created, updated, failed };
}

module.exports = {
    syncBookToNotion,
    syncAllBooksToNotion,
    archiveNotionPage,
};
