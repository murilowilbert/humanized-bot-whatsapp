/**
 * Catalog Service
 * Handles interactions with WhatsApp Business Catalog.
 */

/**
 * Fetches products from the store catalog.
 * @param {import('whatsapp-web.js').Client} client 
 * @param {string} storeId (Optional) owner of the catalog, usually the bot's own number
 * @returns {Promise<Array>} List of products
 */
async function getCatalogProducts(client, storeId = null) {
    try {
        // If storeId is not provided, use the bot's wid
        const targetId = storeId || client.info.wid._serialized;

        // WhatsApp Web JS method to get products
        // Note: This function availability depends on the library version and WhatsApp Web version.
        // We wrap it in try-catch to be safe.
        const products = await client.getProducts(targetId);

        return products.map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            price: p.price,
            currency: p.currency,
            isHidden: p.isHidden,
            url: p.url,
            image: p.image // URL or object
        }));
    } catch (error) {
        console.error("Erro ao buscar catálogo:", error);
        return [];
    }
}

/**
 * Format a catalog product for the AI context
 */
function formatProductForAI(product) {
    return `${product.name} (${product.price} ${product.currency}) - ${product.description || ''}`;
}

module.exports = {
    getCatalogProducts,
    formatProductForAI
};
