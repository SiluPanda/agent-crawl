import * as cheerio from 'cheerio';
import type { ExtractedTable } from '../types.js';

const MAX_TABLES = 100;
const MAX_ROWS = 10_000;
const MAX_COLS = 500;
const MAX_CELL_LENGTH = 10_000;
const MIN_SCORE = 3;

function cleanText(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_CELL_LENGTH);
}

/**
 * Score a table element to distinguish data tables from layout tables.
 * Higher score = more likely to be a data table.
 */
function scoreTable($: ReturnType<typeof cheerio.load>, table: cheerio.Element): number {
    const $table = $(table);
    let score = 0;

    // Positive signals
    if ($table.find('th').length > 0) score += 3; // has header cells
    if ($table.find('thead').length > 0) score += 2; // has thead
    if ($table.find('tbody').length > 0) score += 1; // has tbody
    if ($table.find('caption').length > 0) score += 2; // has caption
    if ($table.attr('summary')) score += 1; // has summary attribute

    const rows = $table.find('tr');
    const rowCount = rows.length;
    if (rowCount >= 2) score += 1; // at least 2 rows
    if (rowCount >= 5) score += 1; // substantial table

    // Check column consistency (data tables have consistent column counts)
    if (rowCount > 0) {
        const colCounts: number[] = [];
        rows.each((_, row) => {
            colCounts.push($(row).find('td, th').length);
        });
        const maxCols = Math.max(...colCounts);
        const minCols = Math.min(...colCounts);
        if (maxCols > 0 && minCols === maxCols) score += 2; // perfectly consistent columns
        else if (maxCols > 0 && minCols >= maxCols - 1) score += 1; // nearly consistent
    }

    // Negative signals (layout table indicators)
    const role = $table.attr('role');
    if (role === 'presentation' || role === 'none') score -= 10;
    const classes = ($table.attr('class') || '').toLowerCase();
    if (classes.includes('layout') || classes.includes('nav') || classes.includes('menu')) score -= 5;
    // Nested tables are often layout
    if ($table.find('table').length > 0) score -= 3;
    // Single-row single-column = likely layout
    if (rowCount === 1) score -= 2;

    return score;
}

/**
 * Extract structured tables from HTML.
 * Uses a scoring algorithm to filter out layout/navigation tables.
 */
export function extractTables(html: string): ExtractedTable[] {
    const $ = cheerio.load(html);
    const tables: ExtractedTable[] = [];

    $('table').each((_, tableEl) => {
        if (tables.length >= MAX_TABLES) return false;

        const score = scoreTable($, tableEl);
        if (score < MIN_SCORE) return; // skip layout tables

        const $table = $(tableEl);

        // Extract caption
        const caption = cleanText($table.find('caption').first().text()) || undefined;

        // Extract headers
        const headers: string[] = [];
        const $headerRow = $table.find('thead tr').first();
        if ($headerRow.length > 0) {
            $headerRow.find('th, td').each((_, cell) => {
                if (headers.length < MAX_COLS) headers.push(cleanText($(cell).text()));
            });
        } else {
            // Fallback: first row with <th> elements
            const $firstRow = $table.find('tr').first();
            const ths = $firstRow.find('th');
            if (ths.length > 0) {
                ths.each((_, cell) => {
                    if (headers.length < MAX_COLS) headers.push(cleanText($(cell).text()));
                });
            } else {
                // No headers found — use first row as headers if table has >1 row
                const allRows = $table.find('tr');
                if (allRows.length > 1) {
                    $firstRow.find('td').each((_, cell) => {
                        if (headers.length < MAX_COLS) headers.push(cleanText($(cell).text()));
                    });
                }
            }
        }

        // Extract body rows
        const rows: string[][] = [];
        const $bodyRows = $table.find('tbody tr').length > 0
            ? $table.find('tbody tr')
            : $table.find('tr');

        $bodyRows.each((rowIdx, row) => {
            if (rows.length >= MAX_ROWS) return false;

            const cells: string[] = [];
            $(row).find('td, th').each((_, cell) => {
                if (cells.length < MAX_COLS) cells.push(cleanText($(cell).text()));
            });

            // Skip the header row if it was already extracted
            if (rowIdx === 0 && headers.length > 0) {
                // Check if this row matches the headers (it's the header row)
                const isHeaderRow = cells.length === headers.length &&
                    cells.every((c, i) => c === headers[i]);
                if (isHeaderRow) return;
            }

            // Skip empty rows
            if (cells.length === 0 || cells.every(c => c === '')) return;

            rows.push(cells);
        });

        // Only include tables with at least 1 row of data
        if (rows.length > 0) {
            tables.push({ headers, rows, caption });
        }
    });

    return tables;
}
