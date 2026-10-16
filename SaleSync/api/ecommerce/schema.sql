-- ShopHub-to-SaleSync order bridge. Import once into the SaleSync database.
-- This does not change existing products, stock, or POS transactions.
CREATE TABLE IF NOT EXISTS ecommerce_orders (
    order_number VARCHAR(30) PRIMARY KEY,
    customer_name VARCHAR(150) NOT NULL,
    customer_email VARCHAR(150) NOT NULL,
    payment_method ENUM('CASH_ON_DELIVERY') NOT NULL DEFAULT 'CASH_ON_DELIVERY',
    subtotal DECIMAL(12,2) NOT NULL,
    item_discount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    shipping_fee DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    shipping_discount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    total_amount DECIMAL(12,2) NOT NULL,
    status ENUM('RESERVED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'RESERVED',
    transaction_id BIGINT UNSIGNED NULL UNIQUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    CONSTRAINT fk_ecommerce_order_transaction
        FOREIGN KEY (transaction_id) REFERENCES sales_transactions(transaction_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ecommerce_order_items (
    order_number VARCHAR(30) NOT NULL,
    product_id INT UNSIGNED NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    unit_price DECIMAL(12,2) NOT NULL,
    unit_cost DECIMAL(12,2) NOT NULL,
    item_discount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    PRIMARY KEY (order_number, product_id),
    CONSTRAINT chk_ecommerce_item_qty CHECK (quantity > 0),
    CONSTRAINT fk_ecommerce_item_order
        FOREIGN KEY (order_number) REFERENCES ecommerce_orders(order_number)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_ecommerce_item_product
        FOREIGN KEY (product_id) REFERENCES products(product_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ShopHub-created products still use SaleSync's products and inventory tables.
-- This small link table keeps the ShopHub seller and display-only fields that
-- SaleSync's POS product table does not have.
CREATE TABLE IF NOT EXISTS ecommerce_product_metadata (
    product_id INT UNSIGNED PRIMARY KEY,
    seller_id VARCHAR(100) NOT NULL,
    seller_email VARCHAR(150) NOT NULL,
    seller_name VARCHAR(150) NOT NULL,
    original_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    image VARCHAR(255) NOT NULL DEFAULT '📦',
    description TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_ecommerce_product_metadata_product
        FOREIGN KEY (product_id) REFERENCES products(product_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
