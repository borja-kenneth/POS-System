-- ============================================================
-- SaleSync Database Schema
-- MariaDB 10.4.32+ / MySQL 8.0+ (XAMPP compatible)
-- Creates missing schema objects without dropping tables or operational data.
-- Single import file for a fresh/empty SaleSync schema: tables + demo accounts + sample data + reporting views
-- Designed for:
--   POS checkout
--   Central inventory
--   Sales ledger
--   Analytics / reports
--   Discounts / vouchers
--   Transaction history / audit trail
--   Digital receipts
--   PayMongo integration (reference data only)
--   POS <-> E-commerce API integration
-- ============================================================

SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS salesync
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE salesync;

-- Detect a database with no existing SaleSync schema. Existing tables/data are preserved.
SET @salesync_fresh_install := (SELECT COUNT(*) = 0 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users');
SET FOREIGN_KEY_CHECKS = 0;

DROP VIEW IF EXISTS vw_sales_ledger;
DROP VIEW IF EXISTS vw_product_stock;
DROP VIEW IF EXISTS vw_daily_sales;

-- Intentionally do not DROP tables: this combined file is safe to re-import
-- for feature upgrades without deleting live products, sales, users, or expenses.

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- 1. USERS / ROLES
-- ============================================================

CREATE TABLE IF NOT EXISTS roles (
    role_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    role_name VARCHAR(50) NOT NULL UNIQUE,
    description VARCHAR(255) NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
    user_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    role_id INT UNSIGNED NOT NULL,
    username VARCHAR(50) NOT NULL UNIQUE,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_users_role
        FOREIGN KEY (role_id) REFERENCES roles(role_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;


-- ============================================================
-- 1A. PERSISTENT SYSTEM SETTINGS (Admin-configurable)
-- ============================================================
CREATE TABLE IF NOT EXISTS system_settings (
    settings_id TINYINT UNSIGNED PRIMARY KEY,
    store_name VARCHAR(100) NOT NULL DEFAULT 'SaleSync Store',
    store_address VARCHAR(255) NOT NULL DEFAULT '',
    store_phone VARCHAR(40) NOT NULL DEFAULT '',
    store_email VARCHAR(150) NOT NULL DEFAULT '',
    receipt_footer VARCHAR(255) NOT NULL DEFAULT 'Thank you for shopping!',
    currency_symbol VARCHAR(8) NOT NULL DEFAULT '₱',
    date_format VARCHAR(20) NOT NULL DEFAULT 'DD MMM YYYY',
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Manila',
    default_low_stock_threshold INT UNSIGNED NOT NULL DEFAULT 10,
    barcode_prefix VARCHAR(10) NOT NULL DEFAULT 'SS',
    receipt_prefix VARCHAR(12) NOT NULL DEFAULT 'POS',
    return_window_days SMALLINT UNSIGNED NOT NULL DEFAULT 7,
    default_return_restock BOOLEAN NOT NULL DEFAULT TRUE,
    enable_cash BOOLEAN NOT NULL DEFAULT TRUE,
    enable_card BOOLEAN NOT NULL DEFAULT TRUE,
    enable_online BOOLEAN NOT NULL DEFAULT TRUE,
    allow_store_credit_refund BOOLEAN NOT NULL DEFAULT TRUE,
    allow_original_method_refund BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by INT UNSIGNED NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_system_settings_user FOREIGN KEY (updated_by) REFERENCES users(user_id)
        ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================
-- 2. PRODUCT CATALOG
-- ============================================================

CREATE TABLE IF NOT EXISTS categories (
    category_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    category_name VARCHAR(100) NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS products (
    product_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    product_name VARCHAR(150) NOT NULL,
    barcode VARCHAR(64) NULL UNIQUE,
    category_id INT UNSIGNED NOT NULL,
    cost_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    selling_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    reorder_point INT UNSIGNED NOT NULL DEFAULT 12,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_products_cost_price CHECK (cost_price >= 0),
    CONSTRAINT chk_products_selling_price CHECK (selling_price >= 0),
    CONSTRAINT fk_products_category
        FOREIGN KEY (category_id) REFERENCES categories(category_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

-- Current central stock. One row per product.
-- quantity_on_hand = physical units currently held by the store.
-- quantity_reserved = units temporarily held for pending e-commerce orders.
CREATE TABLE IF NOT EXISTS inventory (
    product_id INT UNSIGNED PRIMARY KEY,
    quantity_on_hand INT NOT NULL DEFAULT 0,
    quantity_reserved INT NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_inventory_quantity CHECK (quantity_on_hand >= 0),
    CONSTRAINT chk_inventory_reserved CHECK (quantity_reserved >= 0 AND quantity_reserved <= quantity_on_hand),
    CONSTRAINT fk_inventory_product
        FOREIGN KEY (product_id) REFERENCES products(product_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

-- Every stock change is recorded here. This supports restocking, sales,
-- returns, corrections, and a proper inventory history.
CREATE TABLE IF NOT EXISTS inventory_movements (
    movement_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    product_id INT UNSIGNED NOT NULL,
    movement_type ENUM('PURCHASE','SALE','RETURN','ADJUSTMENT','RESTOCK','RESERVATION','RELEASE') NOT NULL,
    quantity_change INT NOT NULL,
    quantity_before INT NOT NULL,
    quantity_after INT NOT NULL,
    reference_type VARCHAR(50) NULL,
    reference_id VARCHAR(100) NULL,
    reason VARCHAR(255) NULL,
    created_by INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_inventory_movements_product_date (product_id, created_at),
    CONSTRAINT fk_inventory_movement_product
        FOREIGN KEY (product_id) REFERENCES products(product_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_movement_user
        FOREIGN KEY (created_by) REFERENCES users(user_id)
        ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;


-- ============================================================
-- 3. VOUCHERS / DISCOUNTS
-- ============================================================

CREATE TABLE IF NOT EXISTS vouchers (
    voucher_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    voucher_code VARCHAR(50) NOT NULL UNIQUE,
    description VARCHAR(255) NULL,
    discount_type ENUM('PERCENTAGE','FIXED') NOT NULL DEFAULT 'PERCENTAGE',
    discount_value DECIMAL(12,2) NOT NULL,
    minimum_purchase DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    usage_limit INT UNSIGNED NULL,
    used_count INT UNSIGNED NOT NULL DEFAULT 0,
    starts_at DATETIME NULL,
    expires_at DATETIME NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_voucher_discount_value CHECK (discount_value >= 0),
    CONSTRAINT chk_voucher_minimum_purchase CHECK (minimum_purchase >= 0)
) ENGINE=InnoDB;

-- ============================================================
-- 4. SALES / TRANSACTIONS
-- ============================================================

-- This is the master record for a completed or in-progress sale.
-- source_channel is important for POS <-> E-commerce reporting.
CREATE TABLE IF NOT EXISTS sales_transactions (
    transaction_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    receipt_number VARCHAR(50) NOT NULL UNIQUE,
    source_channel ENUM('PHYSICAL','ECOMMERCE') NOT NULL DEFAULT 'PHYSICAL',
    external_order_id VARCHAR(100) NULL,
    user_id INT UNSIGNED NULL,
    customer_name VARCHAR(150) NULL,
    customer_email VARCHAR(150) NULL,
    subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    status ENUM('PENDING','COMPLETED','CANCELLED','REFUNDED') NOT NULL DEFAULT 'PENDING',
    voucher_id INT UNSIGNED NULL,
    notes VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    KEY idx_sales_transactions_date (created_at),
    KEY idx_sales_transactions_channel_status (source_channel, status),
    CONSTRAINT fk_sales_transaction_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_sales_transaction_voucher
        FOREIGN KEY (voucher_id) REFERENCES vouchers(voucher_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT uq_sales_external_order
        UNIQUE (source_channel, external_order_id),
    CONSTRAINT chk_sales_amounts CHECK (
        subtotal >= 0 AND discount_amount >= 0 AND tax_amount >= 0 AND total_amount >= 0
    ),
    CONSTRAINT chk_sales_external_order CHECK (
        (source_channel = 'PHYSICAL' AND external_order_id IS NULL)
        OR
        (source_channel = 'ECOMMERCE' AND external_order_id IS NOT NULL)
    )
) ENGINE=InnoDB;



-- Product lines belonging to a transaction.
-- We save the price/cost at time of sale so later product price changes
-- do not alter historical reports.
CREATE TABLE IF NOT EXISTS sale_items (
    sale_item_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    transaction_id BIGINT UNSIGNED NOT NULL,
    product_id INT UNSIGNED NOT NULL,
    category_id INT UNSIGNED NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    unit_price DECIMAL(12,2) NOT NULL,
    unit_cost DECIMAL(12,2) NOT NULL,
    discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    line_total DECIMAL(12,2) NOT NULL,
    KEY idx_sale_items_transaction (transaction_id),
    KEY idx_sale_items_product (product_id),
    KEY idx_sale_items_category (category_id),
    CONSTRAINT chk_sale_items_quantity CHECK (quantity > 0),
    CONSTRAINT chk_sale_items_prices CHECK (unit_price >= 0 AND unit_cost >= 0),
    CONSTRAINT chk_sale_items_discount CHECK (discount_amount >= 0),
    CONSTRAINT fk_sale_items_transaction
        FOREIGN KEY (transaction_id) REFERENCES sales_transactions(transaction_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_sale_items_product
        FOREIGN KEY (product_id) REFERENCES products(product_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_sale_items_category
        FOREIGN KEY (category_id) REFERENCES categories(category_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;



-- ============================================================
-- 5. PAYMENTS / PAYMONGO REFERENCE DATA
-- ============================================================

-- Do NOT store card numbers, CVV, full payment credentials, or PayMongo
-- secret keys in this table. Store only safe provider references/statuses.
CREATE TABLE IF NOT EXISTS payments (
    payment_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    transaction_id BIGINT UNSIGNED NOT NULL,
    payment_method ENUM('CASH','CARD','ONLINE') NOT NULL,
    payment_provider VARCHAR(50) NULL,
    provider_payment_id VARCHAR(150) NULL,
    provider_checkout_id VARCHAR(150) NULL,
    amount DECIMAL(12,2) NOT NULL,
    status ENUM('PENDING','PAID','FAILED','REFUNDED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    refunded_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    cash_received DECIMAL(12,2) NULL,
    change_amount DECIMAL(12,2) NULL,
    paid_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_payments_transaction (transaction_id),
    KEY idx_payments_status (status),
    CONSTRAINT fk_payments_transaction
        FOREIGN KEY (transaction_id) REFERENCES sales_transactions(transaction_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT chk_payments_amount CHECK (amount >= 0),
    CONSTRAINT chk_payments_refunded CHECK (refunded_amount >= 0 AND refunded_amount <= amount),
    CONSTRAINT chk_payments_cash CHECK (
        cash_received IS NULL OR cash_received >= 0
    ),
    CONSTRAINT uq_provider_payment UNIQUE (payment_provider, provider_payment_id)
) ENGINE=InnoDB;



-- ============================================================
-- 6. RETURNS / REFUNDS
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_returns (
    return_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    return_number VARCHAR(60) NOT NULL UNIQUE,
    transaction_id BIGINT UNSIGNED NOT NULL,
    processed_by INT UNSIGNED NULL,
    reason VARCHAR(255) NOT NULL,
    refund_method ENUM('CASH','ORIGINAL_METHOD','STORE_CREDIT') NOT NULL DEFAULT 'CASH',
    refund_status ENUM('RECORDED','PENDING_PROVIDER','PROCESSED','FAILED') NOT NULL DEFAULT 'RECORDED',
    refund_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    net_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    status ENUM('COMPLETED','CANCELLED') NOT NULL DEFAULT 'COMPLETED',
    notes VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_sales_returns_transaction (transaction_id, status),
    KEY idx_sales_returns_created (created_at),
    CONSTRAINT fk_sales_returns_transaction FOREIGN KEY (transaction_id)
        REFERENCES sales_transactions(transaction_id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_sales_returns_user FOREIGN KEY (processed_by)
        REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT chk_sales_returns_amounts CHECK (refund_amount >= 0 AND net_amount >= 0 AND tax_amount >= 0)
) ENGINE=InnoDB;


CREATE TABLE IF NOT EXISTS sales_return_items (
    return_item_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    return_id BIGINT UNSIGNED NOT NULL,
    sale_item_id BIGINT UNSIGNED NOT NULL,
    product_id INT UNSIGNED NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    net_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    refund_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    restocked BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_sales_return_items_sale_item (sale_item_id),
    CONSTRAINT chk_sales_return_items_quantity CHECK (quantity > 0),
    CONSTRAINT chk_sales_return_items_amounts CHECK (net_amount >= 0 AND tax_amount >= 0 AND refund_amount >= 0),
    CONSTRAINT fk_sales_return_items_return FOREIGN KEY (return_id)
        REFERENCES sales_returns(return_id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_sales_return_items_sale_item FOREIGN KEY (sale_item_id)
        REFERENCES sale_items(sale_item_id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_sales_return_items_product FOREIGN KEY (product_id)
        REFERENCES products(product_id) ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;


-- ============================================================
-- 7. DIGITAL RECEIPTS
-- ============================================================

CREATE TABLE IF NOT EXISTS digital_receipts (
    receipt_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    transaction_id BIGINT UNSIGNED NOT NULL,
    recipient_email VARCHAR(150) NOT NULL,
    delivery_status ENUM('PENDING','SENT','FAILED') NOT NULL DEFAULT 'PENDING',
    sent_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_digital_receipts_transaction
        FOREIGN KEY (transaction_id) REFERENCES sales_transactions(transaction_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ============================================================
-- 8. EXPENSES
-- ============================================================

-- Used by the P&L report. This is preferable to hard-coding Rent,
-- Wages, Utilities, etc. in JavaScript.
CREATE TABLE IF NOT EXISTS expenses (
    expense_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    expense_category VARCHAR(100) NOT NULL,
    description VARCHAR(255) NULL,
    amount DECIMAL(12,2) NOT NULL,
    expense_date DATE NOT NULL,
    created_by INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_expenses_date (expense_date),
    CONSTRAINT chk_expenses_amount CHECK (amount >= 0),
    CONSTRAINT fk_expenses_user
        FOREIGN KEY (created_by) REFERENCES users(user_id)
        ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;


-- ============================================================
-- 9. AUDIT TRAIL
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    audit_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NULL,
    entity_id VARCHAR(100) NULL,
    old_value JSON NULL,
    new_value JSON NULL,
    ip_address VARCHAR(45) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_audit_created_at (created_at),
    KEY idx_audit_entity (entity_type, entity_id),
    CONSTRAINT fk_audit_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;



-- ============================================================
-- 10. API / SYSTEM INTEGRATION LOG
-- ============================================================

-- Useful for the System Integration and Architecture requirement.
-- This records API events between the POS and external systems.
CREATE TABLE IF NOT EXISTS integration_events (
    integration_event_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    source_system VARCHAR(50) NOT NULL,
    target_system VARCHAR(50) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    idempotency_key VARCHAR(150) NULL,
    external_reference_id VARCHAR(150) NULL,
    http_method VARCHAR(10) NULL,
    endpoint VARCHAR(255) NULL,
    status_code SMALLINT UNSIGNED NULL,
    processing_status ENUM('RECEIVED','PROCESSING','SUCCESS','FAILED') NOT NULL DEFAULT 'RECEIVED',
    error_message VARCHAR(500) NULL,
    payload JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME NULL,
    KEY idx_integration_external_ref (source_system, external_reference_id),
    KEY idx_integration_created_at (created_at),
    CONSTRAINT uq_integration_idempotency UNIQUE (idempotency_key)
) ENGINE=InnoDB;




-- ============================================================
-- This installer targets an empty SaleSync schema.

-- ============================================================
-- SEED DATA
-- ============================================================

INSERT IGNORE INTO roles (role_name, description) VALUES
('ADMIN', 'Full access to POS administration and reports'),
('CASHIER', 'Physical store checkout and transaction functions');

-- Demo account used by the UI/backend until authentication is implemented.
INSERT IGNORE INTO users (role_id, username, full_name, email, password_hash)
SELECT role_id, 'admin', 'Store Administrator', 'admin@salesync.local', '$2y$12$kC3uVgRo4PXQv3wctA.FKOiUfSkSi.aB8CImRahNjP7I4Nr5svddG'
FROM roles
WHERE role_name = 'ADMIN';

INSERT IGNORE INTO users (role_id, username, full_name, email, password_hash)
SELECT role_id, 'cashier', 'Store Cashier', 'cashier@salesync.local', '$2y$12$rjJK5VUNNcqE4IrtezXW1.kNJryzjqOzHOhfOPQwZ.EAL0QgNIsSu'
FROM roles
WHERE role_name = 'CASHIER';

INSERT IGNORE INTO system_settings (settings_id, store_name, receipt_footer, currency_symbol, date_format, timezone,
    default_low_stock_threshold, barcode_prefix, receipt_prefix, return_window_days,
    default_return_restock, enable_cash, enable_card, enable_online, allow_store_credit_refund, allow_original_method_refund)
VALUES (1, 'SaleSync Store', 'Thank you for shopping!', '₱', 'DD MMM YYYY', 'Asia/Manila', 10, 'SS', 'POS', 7, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE);

INSERT IGNORE INTO categories (category_name) VALUES
('Beverages'),
('Snacks'),
('Bakery'),
('Dairy'),
('Household'),
('Personal Care');

INSERT IGNORE INTO vouchers
(voucher_code, description, discount_type, discount_value)
VALUES
('SENIOR20', 'Senior/PWD discount', 'PERCENTAGE', 20.00),
('BULK10', 'Bulk order discount', 'PERCENTAGE', 10.00),
('WELCOME5', 'First-time customer discount', 'PERCENTAGE', 5.00);

-- ============================================================
-- REPORTING VIEWS
-- ============================================================

-- Current central stock with product/category information.
-- available_quantity is the quantity an e-commerce client may safely use for new orders.
CREATE VIEW vw_product_stock AS
SELECT
    p.product_id,
    p.product_name,
    c.category_name,
    i.quantity_on_hand,
    i.quantity_reserved,
    (i.quantity_on_hand - i.quantity_reserved) AS available_quantity,
    p.reorder_point,
    p.cost_price,
    p.selling_price,
    CASE
        WHEN (i.quantity_on_hand - i.quantity_reserved) <= 0 THEN 'OUT_OF_STOCK'
        WHEN (i.quantity_on_hand - i.quantity_reserved) <= p.reorder_point THEN 'LOW_STOCK'
        ELSE 'IN_STOCK'
    END AS stock_status
FROM products p
JOIN categories c ON c.category_id = p.category_id
JOIN inventory i ON i.product_id = p.product_id
WHERE p.is_active = TRUE;

-- Sales ledger reflects accepted returns (net sold quantity and revenue).
CREATE VIEW vw_sales_ledger AS
SELECT
    st.transaction_id,
    st.receipt_number,
    st.created_at AS transaction_date,
    st.source_channel,
    pay.payment_method,
    si.sale_item_id,
    si.product_id,
    COALESCE(si.category_id, p.category_id) AS category_id,
    p.product_name,
    c.category_name,
    GREATEST(si.quantity - COALESCE(ret.returned_quantity, 0), 0) AS quantity,
    si.unit_price,
    si.unit_cost,
    GREATEST(si.line_total - COALESCE(ret.returned_net_amount, 0), 0) AS total,
    (GREATEST(si.line_total - COALESCE(ret.returned_net_amount, 0), 0)
      - (GREATEST(si.quantity - COALESCE(ret.returned_quantity, 0), 0) * si.unit_cost)) AS gross_profit,
    st.status
FROM sale_items si
JOIN sales_transactions st ON st.transaction_id = si.transaction_id
LEFT JOIN payments pay ON pay.transaction_id = st.transaction_id
JOIN products p ON p.product_id = si.product_id
JOIN categories c ON c.category_id = COALESCE(si.category_id, p.category_id)
LEFT JOIN (
    SELECT sri.sale_item_id, SUM(sri.quantity) AS returned_quantity,
           SUM(sri.net_amount) AS returned_net_amount
    FROM sales_return_items sri
    JOIN sales_returns sr ON sr.return_id = sri.return_id
    WHERE sr.status = 'COMPLETED'
    GROUP BY sri.sale_item_id
) ret ON ret.sale_item_id = si.sale_item_id
WHERE st.status = 'COMPLETED'
  AND GREATEST(si.quantity - COALESCE(ret.returned_quantity, 0), 0) > 0;

-- Daily summary reports net revenue after accepted returns.
CREATE VIEW vw_daily_sales AS
SELECT
    DATE(st.completed_at) AS sale_date,
    st.source_channel,
    COUNT(DISTINCT st.transaction_id) AS transaction_count,
    SUM(st.subtotal) AS subtotal,
    SUM(st.discount_amount) AS discounts,
    SUM(st.tax_amount) AS tax,
    SUM(st.total_amount) AS gross_revenue,
    COALESCE(SUM(ret.refund_amount), 0) AS refunds,
    SUM(st.total_amount) - COALESCE(SUM(ret.refund_amount), 0) AS revenue
FROM sales_transactions st
LEFT JOIN (
    SELECT transaction_id, SUM(refund_amount) AS refund_amount
    FROM sales_returns WHERE status = 'COMPLETED'
    GROUP BY transaction_id
) ret ON ret.transaction_id = st.transaction_id
WHERE st.status = 'COMPLETED'
GROUP BY DATE(st.completed_at), st.source_channel;

-- ============================================================
-- SAMPLE PRODUCT DATA
-- ============================================================

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'House Blend Coffee 250g', category_id, 100.00, 145.00, 10
FROM categories WHERE category_name = 'Beverages' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Sparkling Water 500ml', category_id, 10.00, 18.00, 10
FROM categories WHERE category_name = 'Beverages' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Oat Milk 1L', category_id, 80.00, 120.00, 10
FROM categories WHERE category_name = 'Dairy' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Sea Salt Chips', category_id, 35.00, 55.00, 10
FROM categories WHERE category_name = 'Snacks' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Dark Choc Bar', category_id, 40.00, 65.00, 10
FROM categories WHERE category_name = 'Snacks' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Sourdough Loaf', category_id, 90.00, 135.00, 10
FROM categories WHERE category_name = 'Bakery' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Butter Croissant', category_id, 35.00, 55.00, 10
FROM categories WHERE category_name = 'Bakery' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Cheddar Block 200g', category_id, 100.00, 145.00, 10
FROM categories WHERE category_name = 'Dairy' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Greek Yogurt Tub', category_id, 55.00, 85.00, 10
FROM categories WHERE category_name = 'Dairy' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Dish Soap 750ml', category_id, 45.00, 70.00, 10
FROM categories WHERE category_name = 'Household' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Paper Towels 2pk', category_id, 50.00, 80.00, 10
FROM categories WHERE category_name = 'Household' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Shampoo 400ml', category_id, 90.00, 135.00, 10
FROM categories WHERE category_name = 'Personal Care' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Hand Cream 50ml', category_id, 70.00, 110.00, 10
FROM categories WHERE category_name = 'Personal Care' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Cola 12pk', category_id, 90.00, 135.00, 10
FROM categories WHERE category_name = 'Beverages' AND @salesync_fresh_install = 1;

INSERT INTO products
(product_name, category_id, cost_price, selling_price, reorder_point)
SELECT 'Granola Bars 6pk', category_id, 60.00, 95.00, 10
FROM categories WHERE category_name = 'Snacks' AND @salesync_fresh_install = 1;

-- Different products can have different low-stock warning levels.
UPDATE products SET reorder_point = CASE product_id
    WHEN 1 THEN 10
    WHEN 2 THEN 20
    WHEN 3 THEN 5
    WHEN 4 THEN 8
    WHEN 5 THEN 6
    WHEN 6 THEN 5
    WHEN 7 THEN 8
    WHEN 8 THEN 6
    WHEN 9 THEN 6
    WHEN 10 THEN 10
    WHEN 11 THEN 8
    WHEN 12 THEN 5
    WHEN 13 THEN 8
    WHEN 14 THEN 10
    WHEN 15 THEN 12
    ELSE reorder_point
END
WHERE @salesync_fresh_install = 1;


-- Assign Code 39-compatible internal barcodes to the seeded product catalog.
UPDATE products SET barcode = CONCAT(COALESCE((SELECT barcode_prefix FROM system_settings WHERE settings_id=1), 'SS'), LPAD(product_id, 8, '0'))
WHERE barcode IS NULL OR TRIM(barcode) = '';

INSERT IGNORE INTO inventory (product_id, quantity_on_hand, quantity_reserved)
SELECT seed.product_id, seed.quantity_on_hand, seed.quantity_reserved
FROM (
    SELECT 1 AS product_id, 24 AS quantity_on_hand, 0 AS quantity_reserved UNION ALL
    SELECT 2, 53, 0 UNION ALL SELECT 3, 8, 0 UNION ALL SELECT 4, 31, 0 UNION ALL
    SELECT 5, 12, 0 UNION ALL SELECT 6, 15, 0 UNION ALL SELECT 7, 18, 0 UNION ALL
    SELECT 8, 22, 0 UNION ALL SELECT 9, 27, 0 UNION ALL SELECT 10, 7, 0 UNION ALL
    SELECT 11, 14, 0 UNION ALL SELECT 12, 20, 0 UNION ALL SELECT 13, 10, 0 UNION ALL
    SELECT 14, 16, 0 UNION ALL SELECT 15, 25, 0
) AS seed
WHERE @salesync_fresh_install = 1;

-- Opening stock movements for the demo dataset. This is a no-op on reruns.
INSERT INTO inventory_movements
(product_id, movement_type, quantity_change, quantity_before, quantity_after, reference_type, reference_id, reason)
SELECT product_id, 'RESTOCK', quantity_on_hand, 0, quantity_on_hand, 'OPENING_STOCK', 'SEED', 'Initial demo inventory'
FROM inventory
WHERE quantity_on_hand > 0 AND @salesync_fresh_install = 1
  AND NOT EXISTS (SELECT 1 FROM inventory_movements WHERE reference_type='OPENING_STOCK' AND reference_id='SEED');

-- Example operating expenses matching the UI concept, created only on a fresh install.
INSERT INTO expenses (expense_category, description, amount, expense_date)
SELECT 'Rent', 'Monthly store rent', 1800.00, CURRENT_DATE WHERE @salesync_fresh_install = 1
UNION ALL SELECT 'Wages', 'Staff wages', 2600.00, CURRENT_DATE WHERE @salesync_fresh_install = 1
UNION ALL SELECT 'Utilities', 'Electricity and water', 320.00, CURRENT_DATE WHERE @salesync_fresh_install = 1
UNION ALL SELECT 'Marketing', 'Marketing expenses', 250.00, CURRENT_DATE WHERE @salesync_fresh_install = 1
UNION ALL SELECT 'Misc', 'Miscellaneous operating expenses', 180.00, CURRENT_DATE WHERE @salesync_fresh_install = 1;

-- ============================================================
-- END OF SCHEMA
-- ============================================================

-- Post-import verification: these rows should list the SaleSync tables and views.
SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables WHERE TABLE_SCHEMA='salesync' ORDER BY TABLE_TYPE, TABLE_NAME;
