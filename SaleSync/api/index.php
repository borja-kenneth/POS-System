<?php
declare(strict_types=1);

session_set_cookie_params([
    'httponly' => true,
    'samesite' => 'Lax',
    'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'
]);
session_start();
header('Content-Type: application/json; charset=utf-8');

$config = require __DIR__ . '/config.php';

function respond(array $data, int $status = 200): never {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $status = 400): never {
    respond(['error' => $message], $status);
}

function currentUser(): ?array {
    return isset($_SESSION['pos_user']) && is_array($_SESSION['pos_user']) ? $_SESSION['pos_user'] : null;
}

function requireAuth(): array {
    $user = currentUser();
    if (!$user) fail('Please log in to continue.', 401);
    return $user;
}

function requireRole(array $user, string ...$roles): void {
    if (!in_array($user['role_name'] ?? '', $roles, true)) {
        fail('You do not have permission to perform this action.', 403);
    }
}

function body(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function db(array $config): PDO {
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;
    $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
        $config['host'], $config['port'], $config['database']);
    $pdo = new PDO($dsn, $config['username'], $config['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    return $pdo;
}

function query(PDO $pdo, string $sql, array $params = []): array {
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll();
}

function one(PDO $pdo, string $sql, array $params = []): ?array {
    $rows = query($pdo, $sql, $params);
    return $rows[0] ?? null;
}

function execute(PDO $pdo, string $sql, array $params = []): int {
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return $stmt->rowCount();
}

function lastId(PDO $pdo): int {
    return (int)$pdo->lastInsertId();
}

function systemSettings(PDO $pdo): array {
    $row = one($pdo, 'SELECT * FROM system_settings WHERE settings_id=1');
    if (!$row) {
        return [
            'store_name'=>'SaleSync Store','store_address'=>'','store_phone'=>'','store_email'=>'','receipt_footer'=>'Thank you for shopping!',
            'currency_symbol'=>'₱','date_format'=>'DD MMM YYYY','timezone'=>'Asia/Manila','default_low_stock_threshold'=>10,'barcode_prefix'=>'SS','receipt_prefix'=>'POS',
            'return_window_days'=>7,'default_return_restock'=>1,'enable_cash'=>1,'enable_card'=>1,'enable_online'=>1,
            'allow_store_credit_refund'=>1,'allow_original_method_refund'=>1
        ];
    }

    // Repair old imports where the peso sign was converted to a literal question mark.
    // Keep the database value and all displayed amounts consistent without requiring a re-import.
    $allowedCurrencySymbols = ['₱', '$', '€', '£', '¥'];
    $storedCurrencySymbol = (string)($row['currency_symbol'] ?? '');
    if (!in_array($storedCurrencySymbol, $allowedCurrencySymbols, true)) {
        execute($pdo, 'UPDATE system_settings SET currency_symbol=? WHERE settings_id=1', ['₱']);
        $row['currency_symbol'] = '₱';
    }
    return $row;
}

function publicSettings(PDO $pdo): array {
    $s = systemSettings($pdo);
    return [
        'storeName'=>(string)$s['store_name'],'storeAddress'=>(string)$s['store_address'],'storePhone'=>(string)$s['store_phone'],
        'storeEmail'=>(string)$s['store_email'],'receiptFooter'=>(string)$s['receipt_footer'],'currencySymbol'=>(string)$s['currency_symbol'],
        'dateFormat'=>(string)$s['date_format'],'timezone'=>(string)($s['timezone'] ?? 'Asia/Manila'),'defaultLowStockThreshold'=>(int)$s['default_low_stock_threshold'],
        'barcodePrefix'=>(string)$s['barcode_prefix'],'receiptPrefix'=>(string)$s['receipt_prefix'],
        'returnWindowDays'=>(int)$s['return_window_days'],'defaultReturnRestock'=>(bool)$s['default_return_restock'],
        'enableCash'=>(bool)$s['enable_cash'],'enableCard'=>(bool)$s['enable_card'],'enableOnline'=>(bool)$s['enable_online'],
        'allowStoreCreditRefund'=>(bool)$s['allow_store_credit_refund'],'allowOriginalMethodRefund'=>(bool)$s['allow_original_method_refund']
    ];
}

function receiptNumber(PDO $pdo): string {
    $now = new DateTimeImmutable('now');
    $prefix = (string)(systemSettings($pdo)['receipt_prefix'] ?? 'POS');
    return sprintf('%s-%s-%s-%02d', $prefix, $now->format('Ymd'), substr((string)round(microtime(true) * 1000), -6), random_int(10, 99));
}

function generatedProductBarcode(PDO $pdo, int $productId): string {
    $prefix = strtoupper((string)(systemSettings($pdo)['barcode_prefix'] ?? 'SS'));
    $prefix = preg_match('/^[A-Z0-9-]{1,10}$/D', $prefix) ? $prefix : 'SS';
    $base = $prefix . str_pad((string)$productId, 8, '0', STR_PAD_LEFT);
    $candidate = $base;
    $suffix = 0;
    while (one($pdo, 'SELECT product_id FROM products WHERE barcode=? AND product_id<>?', [$candidate, $productId])) {
        $suffix++;
        $candidate = $base . '-' . $suffix;
    }
    return $candidate;
}

function asProduct(array $row): array {
    return [
        'id' => (string)(int)$row['product_id'],
        'productId' => (int)$row['product_id'],
        'name' => $row['product_name'],
        'barcode' => (string)($row['barcode'] ?? ''),
        'cat' => $row['category_name'],
        'categoryId' => (int)$row['category_id'],
        'cost' => (float)$row['cost_price'],
        'price' => (float)$row['selling_price'],
        'stock' => (int)$row['available_quantity'],
        'onHand' => (int)$row['quantity_on_hand'],
        'reserved' => (int)$row['quantity_reserved'],
        'reorder' => (int)$row['reorder_point'],
        'status' => $row['stock_status'],
    ];
}

function validatedExpensePayload(array $input): array {
    $category = trim((string)($input['category'] ?? ''));
    $description = trim((string)($input['description'] ?? ''));
    $amountValue = $input['amount'] ?? null;
    $date = trim((string)($input['date'] ?? ''));
    if ($category === '' || mb_strlen($category) > 100) fail('Enter an expense category up to 100 characters.');
    if (mb_strlen($description) > 255) fail('Description must be 255 characters or fewer.');
    if (!is_numeric($amountValue)) fail('Enter a valid expense amount.');
    $amount = round((float)$amountValue, 2);
    if (!is_finite($amount) || $amount <= 0 || $amount > 9999999999.99) fail('Expense amount must be greater than zero and within the supported range.');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/D', $date)) fail('Choose a valid expense date.');
    [$year, $month, $day] = array_map('intval', explode('-', $date));
    if (!checkdate($month, $day, $year)) fail('Choose a valid expense date.');
    return ['category'=>$category, 'description'=>$description === '' ? null : $description, 'amount'=>$amount, 'date'=>$date];
}

function getBootstrap(PDO $pdo): array {
    $products = query($pdo, "SELECT p.product_id, p.product_name, p.barcode, p.category_id, c.category_name,
        p.cost_price, p.selling_price, p.reorder_point,
        i.quantity_on_hand, i.quantity_reserved,
        (i.quantity_on_hand - i.quantity_reserved) AS available_quantity,
        CASE
            WHEN (i.quantity_on_hand - i.quantity_reserved) <= 0 THEN 'OUT_OF_STOCK'
            WHEN (i.quantity_on_hand - i.quantity_reserved) <= p.reorder_point THEN 'LOW_STOCK'
            ELSE 'IN_STOCK'
        END AS stock_status
        FROM products p
        JOIN categories c ON c.category_id = p.category_id
        JOIN inventory i ON i.product_id = p.product_id
        WHERE p.is_active = TRUE ORDER BY p.product_id");

    $categories = query($pdo, "SELECT category_id, category_name FROM categories WHERE is_active = TRUE ORDER BY category_name");
    $vouchers = query($pdo, "SELECT voucher_id, voucher_code, description, discount_type, discount_value,
        minimum_purchase, usage_limit, used_count, starts_at, expires_at
        FROM vouchers WHERE is_active = TRUE
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (expires_at IS NULL OR expires_at >= NOW()) ORDER BY voucher_code");

    $ledger = query($pdo, "SELECT transaction_id, receipt_number, transaction_date, source_channel, payment_method, product_id, category_id,
        product_name, category_name, quantity, unit_price, unit_cost, total, gross_profit, status
        FROM vw_sales_ledger
        ORDER BY transaction_date DESC, transaction_id DESC");

    $transactions = query($pdo, "SELECT st.transaction_id, st.receipt_number, st.source_channel, st.external_order_id,
        st.customer_name, st.customer_email, st.subtotal, st.discount_amount, st.tax_amount, st.total_amount,
        st.status, st.voucher_id, st.created_at, st.completed_at,
        p.payment_method, p.payment_provider, p.provider_payment_id,
        p.status AS payment_status, p.amount AS payment_amount, p.cash_received, p.change_amount,
        v.voucher_code, COALESCE(rt.returned_amount, 0) AS returned_amount,
        COALESCE(rt.returned_quantity, 0) AS returned_quantity, COALESCE(stq.sold_quantity, 0) AS sold_quantity
        FROM sales_transactions st
        LEFT JOIN payments p ON p.transaction_id = st.transaction_id
        LEFT JOIN vouchers v ON v.voucher_id = st.voucher_id
        LEFT JOIN (SELECT sr.transaction_id, SUM(sri.refund_amount) AS returned_amount, SUM(sri.quantity) AS returned_quantity
            FROM sales_returns sr JOIN sales_return_items sri ON sri.return_id = sr.return_id
            WHERE sr.status = 'COMPLETED' GROUP BY sr.transaction_id) rt ON rt.transaction_id = st.transaction_id
        LEFT JOIN (SELECT transaction_id, SUM(quantity) AS sold_quantity FROM sale_items GROUP BY transaction_id) stq ON stq.transaction_id = st.transaction_id
        WHERE st.status = 'COMPLETED'
        ORDER BY st.transaction_id DESC");

    $expenses = query($pdo, "SELECT expense_id, expense_category, description, amount, expense_date FROM expenses ORDER BY expense_date DESC, expense_id DESC");

    $ids = array_map(fn($r) => (int)$r['transaction_id'], $transactions);
    $itemRows = [];
    if ($ids) {
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $itemRows = query($pdo, "SELECT si.transaction_id, si.sale_item_id, si.product_id, p.product_name,
            si.quantity, si.unit_price, si.unit_cost, si.discount_amount, si.line_total
            FROM sale_items si JOIN products p ON p.product_id = si.product_id
            WHERE si.transaction_id IN ($placeholders)
            ORDER BY si.transaction_id DESC, si.sale_item_id ASC", $ids);
    }

    $itemsByTx = [];
    foreach ($itemRows as $item) {
        $id = (int)$item['transaction_id'];
        $itemsByTx[$id][] = [
            'saleItemId' => (int)$item['sale_item_id'], 'productId' => (int)$item['product_id'],
            'name' => $item['product_name'], 'qty' => (int)$item['quantity'],
            'price' => (float)$item['unit_price'], 'lineTotal' => (float)$item['line_total']
        ];
    }

    $categoriesMap = array_map(fn($c) => ['id' => (int)$c['category_id'], 'name' => $c['category_name']], $categories);
    $voucherMap = [];
    foreach ($vouchers as $v) {
        $voucherMap[] = [
            'id' => (int)$v['voucher_id'], 'code' => $v['voucher_code'], 'description' => $v['description'] ?? '',
            'type' => $v['discount_type'], 'value' => (float)$v['discount_value'],
            'pct' => $v['discount_type'] === 'PERCENTAGE' ? (float)$v['discount_value'] / 100 : 0,
            'minimumPurchase' => (float)($v['minimum_purchase'] ?? 0)
        ];
    }

    $txs = array_map(function($t) use ($itemsByTx) {
        $id = (int)$t['transaction_id'];
        return [
            'id' => $id, 'receiptNumber' => $t['receipt_number'],
            'time' => date(DATE_ATOM, strtotime($t['completed_at'] ?: $t['created_at'])),
            'sourceChannel' => $t['source_channel'], 'externalOrderId' => $t['external_order_id'],
            'customerName' => $t['customer_name'], 'customerEmail' => $t['customer_email'],
            'subtotal' => (float)$t['subtotal'], 'discount' => (float)$t['discount_amount'],
            'tax' => (float)$t['tax_amount'], 'total' => (float)$t['total_amount'], 'status' => $t['status'],
            'payMethod' => strtoupper((string)($t['payment_method'] ?: 'CASH')) === 'ONLINE' ? 'paymongo' : strtolower((string)($t['payment_method'] ?: 'CASH')),
            'paymentStatus' => $t['payment_status'], 'cashGiven' => (float)($t['cash_received'] ?: 0),
            'change' => (float)($t['change_amount'] ?: 0), 'voucher' => $t['voucher_code'],
            'returnedAmount' => (float)($t['returned_amount'] ?? 0),
            'canReturn' => (int)($t['returned_quantity'] ?? 0) < (int)($t['sold_quantity'] ?? 0),
            'lines' => $itemsByTx[$id] ?? []
        ];
    }, $transactions);

    $expenseTotals = [];
    foreach ($expenses as $e) {
        $expenseTotals[$e['expense_category']] = ($expenseTotals[$e['expense_category']] ?? 0) + (float)$e['amount'];
    }

    return [
        'settings' => publicSettings($pdo),
        'products' => array_map('asProduct', $products),
        'categories' => $categoriesMap,
        'vouchers' => $voucherMap,
        'sales' => array_map(fn($r) => [
            'date' => date('Y-m-d', strtotime($r['transaction_date'])),
            'transactionId' => (int)$r['transaction_id'], 'receiptNumber' => $r['receipt_number'],
            'productId' => (int)($r['product_id'] ?? 0), 'categoryId' => (int)($r['category_id'] ?? 0),
            'sourceChannel' => $r['source_channel'],
            'payMethod' => strtoupper((string)($r['payment_method'] ?? 'CASH')) === 'ONLINE' ? 'paymongo' : strtolower((string)($r['payment_method'] ?? 'cash')),
            'name' => $r['product_name'], 'cat' => $r['category_name'], 'qty' => (int)$r['quantity'], 'price' => (float)$r['unit_price'],
            'cost' => (float)$r['unit_cost'], 'total' => (float)$r['total'], 'profit' => (float)$r['gross_profit']
        ], $ledger),
        'transactions' => $txs,
        'expenses' => $expenseTotals,
        'expenseRows' => array_map(fn($e) => [
            'id' => (int)$e['expense_id'],
            'category' => $e['expense_category'],
            'description' => (string)($e['description'] ?? ''),
            'amount' => (float)$e['amount'],
            'date' => date('Y-m-d', strtotime($e['expense_date']))
        ], $expenses)
    ];
}

try {
    $pdo = db($config);
} catch (Throwable $e) {
    fail('Could not connect to MariaDB. Check XAMPP MySQL and api/config.php.', 500);
}

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$route = trim((string)($_GET['route'] ?? ''), '/');
$parts = $route === '' ? [] : explode('/', $route);

try {
    if ($method === 'GET' && $route === 'health') {
        query($pdo, 'SELECT 1 AS ok');
        respond(['ok' => true, 'database' => $config['database']]);
    }

    if ($method === 'GET' && $route === 'me') {
        $user = currentUser();
        respond($user ? ['authenticated' => true, 'user' => $user] : ['authenticated' => false]);
    }

    if ($method === 'POST' && $route === 'login') {
        $input = body();
        $username = trim((string)($input['username'] ?? ''));
        $password = (string)($input['password'] ?? '');
        if ($username === '' || $password === '') fail('Enter your username and password.');
        $user = one($pdo, "SELECT u.user_id, u.username, u.full_name, u.email, u.password_hash, u.role_id, r.role_name
            FROM users u JOIN roles r ON r.role_id = u.role_id
            WHERE u.username = ? AND u.is_active = TRUE LIMIT 1", [$username]);
        if (!$user || !password_verify($password, $user['password_hash'])) {
            fail('Incorrect username or password.', 401);
        }
        session_regenerate_id(true);
        $_SESSION['pos_user'] = [
            'user_id' => (int)$user['user_id'],
            'username' => $user['username'],
            'full_name' => $user['full_name'],
            'email' => $user['email'],
            'role_id' => (int)$user['role_id'],
            'role_name' => $user['role_name']
        ];
        respond(['ok' => true, 'user' => $_SESSION['pos_user']]);
    }

    if ($method === 'POST' && $route === 'logout') {
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'] ?? '', (bool)$params['secure'], (bool)$params['httponly']);
        }
        session_destroy();
        respond(['ok' => true]);
    }

    $currentUser = requireAuth();

    if ($method === 'GET' && $route === 'bootstrap') {
        respond(getBootstrap($pdo));
    }
    if ($method === 'GET' && $route === 'settings') {
        respond(['settings'=>publicSettings($pdo)]);
    }

    if ($method === 'PUT' && $route === 'settings') {
        requireRole($currentUser, 'ADMIN');
        $input = body();
        $storeName = trim((string)($input['storeName'] ?? ''));
        $storeAddress = trim((string)($input['storeAddress'] ?? ''));
        $storePhone = trim((string)($input['storePhone'] ?? ''));
        $storeEmail = trim((string)($input['storeEmail'] ?? ''));
        $receiptFooter = trim((string)($input['receiptFooter'] ?? ''));
        $currencySymbol = (string)($input['currencySymbol'] ?? '₱');
        $dateFormat = (string)($input['dateFormat'] ?? 'DD MMM YYYY');
        $timezone = (string)($input['timezone'] ?? 'Asia/Manila');
        $allowedTimezones = ['Asia/Manila','Asia/Singapore','UTC','America/Los_Angeles','America/New_York','Europe/London'];
        $defaultLowStock = filter_var($input['defaultLowStockThreshold'] ?? null, FILTER_VALIDATE_INT);
        $barcodePrefix = strtoupper(trim((string)($input['barcodePrefix'] ?? 'SS')));
        $receiptPrefix = strtoupper(trim((string)($input['receiptPrefix'] ?? 'POS')));
        $returnDays = filter_var($input['returnWindowDays'] ?? null, FILTER_VALIDATE_INT);
        $boolFields = ['defaultReturnRestock','enableCash','enableCard','enableOnline','allowStoreCreditRefund','allowOriginalMethodRefund'];
        foreach ($boolFields as $field) if (!array_key_exists($field, $input) || !is_bool($input[$field])) fail('Invalid value for ' . $field . '.');
        if ($storeName === '' || mb_strlen($storeName) > 100) fail('Enter a store name up to 100 characters.');
        if (mb_strlen($storeAddress) > 255 || mb_strlen($storePhone) > 40 || mb_strlen($storeEmail) > 150 || mb_strlen($receiptFooter) > 255) fail('One or more store information fields are too long.');
        if ($storeEmail !== '' && !filter_var($storeEmail, FILTER_VALIDATE_EMAIL)) fail('Enter a valid store email address.');
        if (!in_array($currencySymbol, ['₱','$','€','£','¥'], true)) fail('Choose a supported currency symbol.');
        if (!in_array($dateFormat, ['DD MMM YYYY','DD/MM/YYYY','MM/DD/YYYY','YYYY-MM-DD'], true)) fail('Choose a supported date format.');
        if (!in_array($timezone, $allowedTimezones, true)) fail('Choose a supported timezone.');
        if ($defaultLowStock === false || $defaultLowStock < 0 || $defaultLowStock > 100000) fail('Default low-stock threshold must be between 0 and 100000.');
        if (!preg_match('/^[A-Z0-9-]{1,10}$/D', $barcodePrefix)) fail('Barcode prefix must use 1–10 letters, numbers, or hyphens.');
        if (!preg_match('/^[A-Z0-9-]{1,12}$/D', $receiptPrefix)) fail('Receipt prefix must use 1–12 letters, numbers, or hyphens.');
        if ($returnDays === false || $returnDays < 0 || $returnDays > 3650) fail('Return period must be between 0 and 3650 days.');
        if (!$input['enableCash'] && !$input['enableCard'] && !$input['enableOnline']) fail('At least one payment method must remain enabled.');
        $before = publicSettings($pdo);
        execute($pdo, "UPDATE system_settings SET store_name=?, store_address=?, store_phone=?, store_email=?, receipt_footer=?,
            currency_symbol=?, date_format=?, timezone=?, default_low_stock_threshold=?, barcode_prefix=?, receipt_prefix=?, return_window_days=?,
            default_return_restock=?, enable_cash=?, enable_card=?, enable_online=?, allow_store_credit_refund=?, allow_original_method_refund=?, updated_by=?
            WHERE settings_id=1", [
            $storeName,$storeAddress,$storePhone,$storeEmail,$receiptFooter,$currencySymbol,$dateFormat,$timezone,$defaultLowStock,$barcodePrefix,$receiptPrefix,$returnDays,
            $input['defaultReturnRestock'] ? 1 : 0,$input['enableCash'] ? 1 : 0,$input['enableCard'] ? 1 : 0,$input['enableOnline'] ? 1 : 0,
            $input['allowStoreCreditRefund'] ? 1 : 0,$input['allowOriginalMethodRefund'] ? 1 : 0,$currentUser['user_id']
        ]);
        $after = publicSettings($pdo);
        execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value)
            VALUES (?, 'UPDATE_SETTINGS', 'SYSTEM_SETTINGS', '1', ?, ?)", [$currentUser['user_id'], json_encode($before, JSON_UNESCAPED_UNICODE), json_encode($after, JSON_UNESCAPED_UNICODE)]);
        respond(['ok'=>true,'settings'=>$after]);
    }

    if ($method === 'POST' && $route === 'account/password') {
        requireRole($currentUser, 'ADMIN');
        $input = body();
        $currentPassword = (string)($input['currentPassword'] ?? '');
        $newPassword = (string)($input['newPassword'] ?? '');
        $confirmPassword = (string)($input['confirmPassword'] ?? '');
        if ($currentPassword === '' || $newPassword === '') fail('Enter your current password and new password.');
        if (strlen($newPassword) < 8 || strlen($newPassword) > 128) fail('New password must be 8 to 128 characters.');
        if (!hash_equals($newPassword, $confirmPassword)) fail('The new passwords do not match.');
        $account = one($pdo, 'SELECT password_hash FROM users WHERE user_id=? AND is_active=TRUE LIMIT 1', [(int)$currentUser['user_id']]);
        if (!$account || !password_verify($currentPassword, (string)$account['password_hash'])) fail('The current password is incorrect.', 401);
        execute($pdo, 'UPDATE users SET password_hash=? WHERE user_id=?', [password_hash($newPassword, PASSWORD_DEFAULT), (int)$currentUser['user_id']]);
        execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value) VALUES (?, 'CHANGE_PASSWORD', 'USER', ?, NULL, NULL)", [(int)$currentUser['user_id'], (string)$currentUser['user_id']]);
        respond(['ok'=>true]);
    }

    if ($method === 'GET' && $route === 'categories') {
        requireRole($currentUser, 'ADMIN');
        $rows = query($pdo, "SELECT c.category_id, c.category_name, c.is_active, c.created_at,
            (SELECT COUNT(*) FROM products p WHERE p.category_id=c.category_id AND p.is_active=TRUE) AS active_products
            FROM categories c ORDER BY c.category_name");
        respond(['categories'=>array_map(fn($c)=>[
            'id'=>(int)$c['category_id'], 'name'=>$c['category_name'], 'active'=>(bool)$c['is_active'],
            'activeProducts'=>(int)$c['active_products'], 'createdAt'=>$c['created_at']
        ], $rows)]);
    }

    if ($method === 'POST' && $route === 'categories') {
        requireRole($currentUser, 'ADMIN');
        $input = body();
        $name = trim((string)($input['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 100) fail('Enter a category name up to 100 characters.');
        if (one($pdo, 'SELECT category_id FROM categories WHERE LOWER(category_name)=LOWER(?)', [$name])) fail('That category already exists.');
        $stmt = $pdo->prepare('INSERT INTO categories (category_name, is_active) VALUES (?, TRUE)');
        $stmt->execute([$name]);
        $categoryId = lastId($pdo);
        execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value)
            VALUES (?, 'CREATE_CATEGORY', 'CATEGORY', ?, ?)",
            [$currentUser['user_id'], (string)$categoryId, json_encode(['category_name'=>$name])]);
        respond(['ok'=>true, 'category'=>['id'=>$categoryId, 'name'=>$name, 'active'=>true]], 201);
    }

    if ($method === 'PATCH' && count($parts) === 2 && $parts[0] === 'categories') {
        requireRole($currentUser, 'ADMIN');
        $categoryId = filter_var($parts[1], FILTER_VALIDATE_INT);
        if ($categoryId === false) fail('Invalid category ID.');
        $input = body();
        $active = filter_var($input['active'] ?? null, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        if ($active === null) fail('Specify whether the category should be active.');
        $category = one($pdo, 'SELECT category_id, category_name, is_active FROM categories WHERE category_id=?', [$categoryId]);
        if (!$category) fail('Category not found.', 404);
        if (!$active) {
            $used = one($pdo, 'SELECT COUNT(*) AS n FROM products WHERE category_id=? AND is_active=TRUE', [$categoryId]);
            if ((int)$used['n'] > 0) fail('This category has active products. Move those products to another category before deactivating it.');
        }
        execute($pdo, 'UPDATE categories SET is_active=? WHERE category_id=?', [$active ? 1 : 0, $categoryId]);
        execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value)
            VALUES (?, 'UPDATE_CATEGORY_STATUS', 'CATEGORY', ?, ?)",
            [$currentUser['user_id'], (string)$categoryId, json_encode(['is_active'=>$active])]);
        respond(['ok'=>true, 'active'=>$active]);
    }

    // Operating expenses for the Profit & Loss statement. Each dated expense is
    // stored as its own record so monthly changes never overwrite previous periods.
    if ($method === 'POST' && $route === 'expenses') {
        requireRole($currentUser, 'ADMIN');
        $expense = validatedExpensePayload(body());
        $pdo->beginTransaction();
        try {
            execute($pdo, 'INSERT INTO expenses (expense_category, description, amount, expense_date, created_by) VALUES (?, ?, ?, ?, ?)',
                [$expense['category'], $expense['description'], $expense['amount'], $expense['date'], (int)$currentUser['user_id']]);
            $expenseId = lastId($pdo);
            execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value) VALUES (?, 'CREATE_EXPENSE', 'EXPENSE', ?, ?)",
                [(int)$currentUser['user_id'], (string)$expenseId, json_encode($expense, JSON_UNESCAPED_UNICODE)]);
            $pdo->commit();
            respond(['ok'=>true, 'id'=>$expenseId, 'message'=>'Expense recorded.'], 201);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    if ($method === 'PUT' && count($parts) === 2 && $parts[0] === 'expenses') {
        requireRole($currentUser, 'ADMIN');
        $expenseId = filter_var($parts[1], FILTER_VALIDATE_INT);
        if ($expenseId === false || $expenseId <= 0) fail('Invalid expense ID.');
        $expense = validatedExpensePayload(body());
        $old = one($pdo, 'SELECT expense_id, expense_category, description, amount, expense_date FROM expenses WHERE expense_id=?', [$expenseId]);
        if (!$old) fail('Expense record not found.', 404);
        $oldValue = ['category'=>$old['expense_category'], 'description'=>$old['description'], 'amount'=>(float)$old['amount'], 'date'=>date('Y-m-d', strtotime($old['expense_date']))];
        $pdo->beginTransaction();
        try {
            execute($pdo, 'UPDATE expenses SET expense_category=?, description=?, amount=?, expense_date=? WHERE expense_id=?',
                [$expense['category'], $expense['description'], $expense['amount'], $expense['date'], $expenseId]);
            execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value) VALUES (?, 'UPDATE_EXPENSE', 'EXPENSE', ?, ?, ?)",
                [(int)$currentUser['user_id'], (string)$expenseId, json_encode($oldValue, JSON_UNESCAPED_UNICODE), json_encode($expense, JSON_UNESCAPED_UNICODE)]);
            $pdo->commit();
            respond(['ok'=>true, 'id'=>$expenseId, 'message'=>'Expense updated.']);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    if ($method === 'DELETE' && count($parts) === 2 && $parts[0] === 'expenses') {
        requireRole($currentUser, 'ADMIN');
        $expenseId = filter_var($parts[1], FILTER_VALIDATE_INT);
        if ($expenseId === false || $expenseId <= 0) fail('Invalid expense ID.');
        $old = one($pdo, 'SELECT expense_id, expense_category, description, amount, expense_date FROM expenses WHERE expense_id=?', [$expenseId]);
        if (!$old) fail('Expense record not found.', 404);
        $oldValue = ['category'=>$old['expense_category'], 'description'=>$old['description'], 'amount'=>(float)$old['amount'], 'date'=>date('Y-m-d', strtotime($old['expense_date']))];
        $pdo->beginTransaction();
        try {
            execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value) VALUES (?, 'DELETE_EXPENSE', 'EXPENSE', ?, ?)",
                [(int)$currentUser['user_id'], (string)$expenseId, json_encode($oldValue, JSON_UNESCAPED_UNICODE)]);
            execute($pdo, 'DELETE FROM expenses WHERE expense_id=?', [$expenseId]);
            $pdo->commit();
            respond(['ok'=>true, 'id'=>$expenseId, 'message'=>'Expense deleted.']);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    if ($method === 'GET' && count($parts) === 2 && $parts[0] === 'vouchers') {
        $code = strtoupper(trim(urldecode($parts[1])));
        $v = one($pdo, "SELECT voucher_id, voucher_code, description, discount_type, discount_value, minimum_purchase
            FROM vouchers WHERE voucher_code = ? AND is_active = TRUE
            AND (starts_at IS NULL OR starts_at <= NOW())
            AND (expires_at IS NULL OR expires_at >= NOW())", [$code]);
        if (!$v) fail('Voucher is invalid or inactive.', 404);
        respond(['id'=>(int)$v['voucher_id'], 'code'=>$v['voucher_code'], 'description'=>$v['description'],
            'type'=>$v['discount_type'], 'value'=>(float)$v['discount_value'], 'minimumPurchase'=>(float)$v['minimum_purchase']]);
    }

    if ($method === 'POST' && count($parts) === 3 && $parts[0] === 'inventory' && $parts[2] === 'restock') {
        requireRole($currentUser, 'ADMIN');
        $productId = filter_var($parts[1], FILTER_VALIDATE_INT);
        $input = body();
        $quantity = filter_var($input['quantity'] ?? null, FILTER_VALIDATE_INT);
        if ($productId === false || $quantity === false || $quantity <= 0) fail('A positive whole-number quantity is required.');

        $pdo->beginTransaction();
        $row = one($pdo, 'SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE product_id = ? FOR UPDATE', [$productId]);
        if (!$row) throw new RuntimeException('Product inventory record not found.');
        $before = (int)$row['quantity_on_hand'];
        $after = $before + $quantity;
        execute($pdo, 'UPDATE inventory SET quantity_on_hand = ? WHERE product_id = ?', [$after, $productId]);
        execute($pdo, "INSERT INTO inventory_movements
            (product_id, movement_type, quantity_change, quantity_before, quantity_after, reference_type, reference_id, reason)
            VALUES (?, 'RESTOCK', ?, ?, ?, 'MANUAL_RESTOCK', ?, ?)",
            [$productId, $quantity, $before, $after, (string)$productId, $input['reason'] ?? 'Manual restock from POS']);
        execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value)
            VALUES (?, 'RESTOCK_INVENTORY', 'INVENTORY', ?, ?)",
            [$currentUser['user_id'], (string)$productId, json_encode(['quantity_added'=>$quantity, 'quantity_after'=>$after])]);
        $pdo->commit();
        respond(['ok'=>true, 'quantityOnHand'=>$after]);
    }

    if ($method === 'POST' && count($parts) === 3 && $parts[0] === 'products' && $parts[2] === 'barcode') {
        requireRole($currentUser, 'ADMIN');
        $productId = filter_var($parts[1], FILTER_VALIDATE_INT);
        if ($productId === false || $productId <= 0) fail('Invalid product ID.');
        $pdo->beginTransaction();
        try {
            $product = one($pdo, 'SELECT product_id, barcode FROM products WHERE product_id=? AND is_active=TRUE FOR UPDATE', [$productId]);
            if (!$product) {
                $pdo->rollBack();
                fail('Product not found or inactive.', 404);
            }
            $barcode = trim((string)($product['barcode'] ?? ''));
            if ($barcode === '') {
                $barcode = generatedProductBarcode($pdo, (int)$productId);
                execute($pdo, 'UPDATE products SET barcode=? WHERE product_id=?', [$barcode, $productId]);
                execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value)
                    VALUES (?, 'GENERATE_PRODUCT_BARCODE', 'PRODUCT', ?, ?)",
                    [$currentUser['user_id'], (string)$productId, json_encode(['barcode'=>$barcode])]);
            }
            $pdo->commit();
            respond(['ok'=>true, 'productId'=>(int)$productId, 'barcode'=>$barcode]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    if ($method === 'PUT' && count($parts) === 2 && $parts[0] === 'products') {
        requireRole($currentUser, 'ADMIN');
        $productId = filter_var($parts[1], FILTER_VALIDATE_INT);
        $input = body();
        if ($productId === false) fail('Invalid product id.');
        $categoryId = filter_var($input['categoryId'] ?? null, FILTER_VALIDATE_INT);
        $costPrice = (float)($input['costPrice'] ?? 0);
        $sellingPrice = (float)($input['sellingPrice'] ?? 0);
        $reorderPoint = filter_var($input['reorderPoint'] ?? null, FILTER_VALIDATE_INT);
        $barcode = strtoupper(trim((string)($input['barcode'] ?? ''))); $barcode = $barcode === '' ? null : $barcode;
        if ($barcode !== null && mb_strlen($barcode) > 64) fail('Barcode must be 64 characters or fewer.');
        if ($barcode !== null && !preg_match('/^[A-Z0-9 .\/$+%-]+$/D', $barcode)) fail('Barcode labels support A-Z, 0-9, spaces, and - . $ / + %.');
        if ($categoryId === false) fail('Invalid category.');
        if (!one($pdo, 'SELECT category_id FROM categories WHERE category_id=? AND is_active=TRUE', [$categoryId])) fail('Choose an active category.');
        if ($barcode === null) $barcode = generatedProductBarcode($pdo, (int)$productId);
        if (one($pdo, 'SELECT product_id FROM products WHERE barcode=? AND product_id<>?', [$barcode, $productId])) fail('That barcode is already assigned to another product.');
        if ($costPrice < 0 || $sellingPrice < 0 || $reorderPoint === false || $reorderPoint < 0) fail('Values cannot be negative.');

        execute($pdo, 'UPDATE products SET category_id=?, cost_price=?, selling_price=?, reorder_point=?, barcode=? WHERE product_id=?',
            [$categoryId, $costPrice, $sellingPrice, $reorderPoint, $barcode, $productId]);
        execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value)
            VALUES (?, 'UPDATE_PRODUCT', 'PRODUCT', ?, ?)",
            [$currentUser['user_id'], (string)$productId, json_encode(compact('categoryId','costPrice','sellingPrice','reorderPoint','barcode'))]);
        $bootstrap = getBootstrap($pdo);
        $updated = null;
        foreach ($bootstrap['products'] as $p) if ($p['productId'] === $productId) { $updated = $p; break; }
        respond(['ok'=>true, 'product'=>$updated]);
    }

    if ($method === 'POST' && $route === 'products') {
        requireRole($currentUser, 'ADMIN');
        $input = body();
        $productName = trim((string)($input['productName'] ?? ''));
        $categoryId = filter_var($input['categoryId'] ?? null, FILTER_VALIDATE_INT);
        $costPrice = (float)($input['costPrice'] ?? 0);
        $sellingPrice = (float)($input['sellingPrice'] ?? 0);
        $reorderPoint = filter_var($input['reorderPoint'] ?? systemSettings($pdo)['default_low_stock_threshold'], FILTER_VALIDATE_INT);
        $openingStock = filter_var($input['openingStock'] ?? 0, FILTER_VALIDATE_INT);
        $barcode = strtoupper(trim((string)($input['barcode'] ?? ''))); $barcode = $barcode === '' ? null : $barcode;
        if ($barcode !== null && mb_strlen($barcode) > 64) fail('Barcode must be 64 characters or fewer.');
        if ($barcode !== null && !preg_match('/^[A-Z0-9 .\/$+%-]+$/D', $barcode)) fail('Barcode labels support A-Z, 0-9, spaces, and - . $ / + %.');
        if (!$productName || $categoryId === false) fail('Product name and category are required.');
        if (!one($pdo, 'SELECT category_id FROM categories WHERE category_id=? AND is_active=TRUE', [$categoryId])) fail('Choose an active category.');
        if ($barcode !== null && one($pdo, 'SELECT product_id FROM products WHERE barcode=?', [$barcode])) fail('That barcode is already assigned to another product.');
        if ($costPrice < 0 || $sellingPrice < 0 || $reorderPoint === false || $reorderPoint < 0 || $openingStock === false || $openingStock < 0) fail('Values cannot be negative.');

        $pdo->beginTransaction();
        $stmt = $pdo->prepare('INSERT INTO products (product_name, barcode, category_id, cost_price, selling_price, reorder_point) VALUES (?,?,?,?,?,?)');
        $stmt->execute([$productName, $barcode, $categoryId, $costPrice, $sellingPrice, $reorderPoint]);
        $productId = lastId($pdo);
        if ($barcode === null) {
            $barcode = generatedProductBarcode($pdo, $productId);
            execute($pdo, 'UPDATE products SET barcode=? WHERE product_id=?', [$barcode, $productId]);
        }
        execute($pdo, 'INSERT INTO inventory (product_id, quantity_on_hand, quantity_reserved) VALUES (?, ?, 0)', [$productId, $openingStock]);
        if ($openingStock > 0) {
            execute($pdo, "INSERT INTO inventory_movements
                (product_id, movement_type, quantity_change, quantity_before, quantity_after, reference_type, reference_id, reason, created_by)
                VALUES (?, 'RESTOCK', ?, 0, ?, 'OPENING_STOCK', ?, 'Initial stock when product was created', ?)",
                [$productId, $openingStock, $openingStock, (string)$productId, $currentUser['user_id']]);
        }
        execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value)
            VALUES (?, 'CREATE_PRODUCT', 'PRODUCT', ?, ?)",
            [$currentUser['user_id'], (string)$productId, json_encode(['product_id'=>$productId, 'product_name'=>$productName])]);
        $pdo->commit();
        respond(['ok'=>true, 'productId'=>$productId, 'barcode'=>$barcode], 201);
    }

    if ($method === 'GET' && count($parts) === 3 && $parts[0] === 'transactions' && $parts[2] === 'returnable') {
        requireRole($currentUser, 'ADMIN', 'CASHIER');
        $transactionId = filter_var($parts[1], FILTER_VALIDATE_INT);
        if ($transactionId === false) fail('Invalid transaction ID.');
        $tx = one($pdo, "SELECT transaction_id, receipt_number, total_amount, subtotal, discount_amount, tax_amount, status, completed_at
            FROM sales_transactions WHERE transaction_id=?", [$transactionId]);
        if (!$tx || $tx['status'] !== 'COMPLETED') fail('Only completed transactions can be returned.', 404);
        $returnDays = (int)systemSettings($pdo)['return_window_days'];
        if ($returnDays > 0 && !empty($tx['completed_at']) && strtotime((string)$tx['completed_at']) < strtotime('-' . $returnDays . ' days')) fail('This receipt is outside the configured ' . $returnDays . '-day return period.', 422);
        $items = query($pdo, "SELECT si.sale_item_id, si.product_id, p.product_name, si.quantity AS sold_quantity,
            si.unit_price, si.unit_cost, si.line_total,
            COALESCE(ret.returned_quantity, 0) AS returned_quantity
            FROM sale_items si JOIN products p ON p.product_id=si.product_id
            LEFT JOIN (SELECT sri.sale_item_id, SUM(sri.quantity) AS returned_quantity
                FROM sales_return_items sri JOIN sales_returns sr ON sr.return_id=sri.return_id
                WHERE sr.status='COMPLETED' GROUP BY sri.sale_item_id) ret ON ret.sale_item_id=si.sale_item_id
            WHERE si.transaction_id=? ORDER BY si.sale_item_id", [$transactionId]);
        $returnable = array_map(fn($i)=>[
            'saleItemId'=>(int)$i['sale_item_id'], 'productId'=>(int)$i['product_id'], 'name'=>$i['product_name'],
            'soldQuantity'=>(int)$i['sold_quantity'], 'returnedQuantity'=>(int)$i['returned_quantity'],
            'returnableQuantity'=>max(0, (int)$i['sold_quantity']-(int)$i['returned_quantity']),
            'unitPrice'=>(float)$i['unit_price'], 'lineTotal'=>(float)$i['line_total'], 'unitCost'=>(float)$i['unit_cost']
        ], $items);
        respond(['transaction'=>['id'=>(int)$tx['transaction_id'], 'receiptNumber'=>$tx['receipt_number'],
            'total'=>(float)$tx['total_amount'], 'subtotal'=>(float)$tx['subtotal'], 'discount'=>(float)$tx['discount_amount'],
            'tax'=>(float)$tx['tax_amount']], 'items'=>$returnable]);
    }

    if ($method === 'POST' && count($parts) === 3 && $parts[0] === 'transactions' && $parts[2] === 'returns') {
        requireRole($currentUser, 'ADMIN', 'CASHIER');
        $transactionId = filter_var($parts[1], FILTER_VALIDATE_INT);
        if ($transactionId === false) fail('Invalid transaction ID.');
        $input = body();
        $rawItems = $input['items'] ?? [];
        $reason = trim((string)($input['reason'] ?? ''));
        $refundMethod = strtoupper((string)($input['refundMethod'] ?? 'CASH'));
        if (!is_array($rawItems) || !$rawItems) fail('Select at least one item to return.');
        if ($reason === '' || mb_strlen($reason) > 255) fail('Enter a reason for the return (up to 255 characters).');
        if (!in_array($refundMethod, ['CASH','ORIGINAL_METHOD','STORE_CREDIT'], true)) fail('Choose a valid refund method.');
        $returnSettings = systemSettings($pdo);
        if ($refundMethod === 'STORE_CREDIT' && !(bool)$returnSettings['allow_store_credit_refund']) fail('Store-credit refunds are disabled in SaleSync Settings.');
        if ($refundMethod === 'ORIGINAL_METHOD' && !(bool)$returnSettings['allow_original_method_refund']) fail('Original-method refund records are disabled in SaleSync Settings.');

        $pdo->beginTransaction();
        try {
            $tx = one($pdo, "SELECT * FROM sales_transactions WHERE transaction_id=? FOR UPDATE", [$transactionId]);
            if (!$tx || $tx['status'] !== 'COMPLETED') throw new RuntimeException('Only completed transactions can be returned.');
            $returnDays = (int)$returnSettings['return_window_days'];
            if ($returnDays > 0 && !empty($tx['completed_at']) && strtotime((string)$tx['completed_at']) < strtotime('-' . $returnDays . ' days')) {
                throw new RuntimeException('This receipt is outside the configured ' . $returnDays . '-day return period.');
            }
            $saleItems = query($pdo, "SELECT si.*, p.product_name, i.quantity_on_hand
                FROM sale_items si JOIN products p ON p.product_id=si.product_id
                JOIN inventory i ON i.product_id=si.product_id
                WHERE si.transaction_id=? ORDER BY si.sale_item_id FOR UPDATE", [$transactionId]);
            $sumLineTotals = array_sum(array_map(fn($i)=>(float)$i['line_total'], $saleItems));
            if ($sumLineTotals <= 0) $sumLineTotals = 1;
            $selected = []; $seenSaleItems = [];
            $netRefund = 0.0; $taxRefund = 0.0; $refundTotal = 0.0;
            foreach ($rawItems as $raw) {
                $saleItemId = filter_var($raw['saleItemId'] ?? null, FILTER_VALIDATE_INT);
                $qty = filter_var($raw['quantity'] ?? null, FILTER_VALIDATE_INT);
                $restock = filter_var($raw['restock'] ?? false, FILTER_VALIDATE_BOOLEAN);
                if ($saleItemId === false || $qty === false || $qty <= 0) throw new RuntimeException('Each selected item needs a positive whole-number quantity.');
                if (isset($seenSaleItems[$saleItemId])) throw new RuntimeException('A receipt item can only be listed once per return.');
                $seenSaleItems[$saleItemId] = true;
                $row = null;
                foreach ($saleItems as $candidate) if ((int)$candidate['sale_item_id'] === $saleItemId) { $row = $candidate; break; }
                if (!$row) throw new RuntimeException('A selected item does not belong to this receipt.');
                $returned = one($pdo, "SELECT COALESCE(SUM(sri.quantity),0) AS qty FROM sales_return_items sri
                    JOIN sales_returns sr ON sr.return_id=sri.return_id WHERE sri.sale_item_id=? AND sr.status='COMPLETED'", [$saleItemId]);
                $remaining = (int)$row['quantity'] - (int)($returned['qty'] ?? 0);
                if ($qty > $remaining) throw new RuntimeException($row['product_name'] . " only has $remaining unit(s) left to return.");
                $unitNet = (float)$row['line_total'] / max(1, (int)$row['quantity']);
                $lineNet = round($unitNet * $qty, 2);
                $lineTaxTotal = (float)$tx['tax_amount'] * ((float)$row['line_total'] / $sumLineTotals);
                $lineTax = round($lineTaxTotal * ($qty / max(1, (int)$row['quantity'])), 2);
                $lineRefund = round($lineNet + $lineTax, 2);
                $selected[] = ['row'=>$row, 'qty'=>$qty, 'restock'=>array_key_exists('restock', $raw) ? $restock : (bool)$returnSettings['default_return_restock'], 'net'=>$lineNet, 'tax'=>$lineTax, 'refund'=>$lineRefund];
                $netRefund += $lineNet; $taxRefund += $lineTax; $refundTotal += $lineRefund;
            }
            $refundTotal = round($refundTotal, 2); $netRefund = round($netRefund, 2); $taxRefund = round($taxRefund, 2);
            $returnNumber = 'RET-' . date('Ymd-His') . '-' . random_int(100,999);
            $refundStatus = $refundMethod === 'ORIGINAL_METHOD' ? 'PENDING_PROVIDER' : 'PROCESSED';
            $stmt = $pdo->prepare("INSERT INTO sales_returns
                (return_number, transaction_id, processed_by, reason, refund_method, refund_status, refund_amount, net_amount, tax_amount, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED')");
            $stmt->execute([$returnNumber, $transactionId, $currentUser['user_id'], $reason, $refundMethod, $refundStatus, $refundTotal, $netRefund, $taxRefund]);
            $returnId = lastId($pdo);
            $restockedNames = [];
            foreach ($selected as $item) {
                $r = $item['row'];
                execute($pdo, "INSERT INTO sales_return_items
                    (return_id, sale_item_id, product_id, quantity, net_amount, tax_amount, refund_amount, restocked)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [$returnId, $r['sale_item_id'], $r['product_id'], $item['qty'], $item['net'], $item['tax'], $item['refund'], $item['restock'] ? 1 : 0]);
                if ($item['restock']) {
                    $before = (int)$r['quantity_on_hand']; $after = $before + $item['qty'];
                    execute($pdo, 'UPDATE inventory SET quantity_on_hand=? WHERE product_id=?', [$after, $r['product_id']]);
                    execute($pdo, "INSERT INTO inventory_movements
                        (product_id, movement_type, quantity_change, quantity_before, quantity_after, reference_type, reference_id, reason, created_by)
                        VALUES (?, 'RETURN', ?, ?, ?, 'RETURN', ?, ?, ?)",
                        [$r['product_id'], $item['qty'], $before, $after, (string)$returnId, 'Customer return: ' . $reason, $currentUser['user_id']]);
                    $restockedNames[] = $r['product_name'];
                }
            }
            // The original payment record describes the tender used at checkout.
            // Cash/store-credit refunds are recorded in sales_returns; do not mark
            // the original card/online payment refunded without provider confirmation.
            execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value)
                VALUES (?, 'PROCESS_RETURN', 'SALE_RETURN', ?, ?)",
                [$currentUser['user_id'], (string)$returnId, json_encode(['transaction_id'=>$transactionId,'return_number'=>$returnNumber,
                    'refund_amount'=>$refundTotal,'refund_method'=>$refundMethod,'refund_status'=>$refundStatus,'reason'=>$reason,'restocked'=>$restockedNames])]);
            $pdo->commit();
            respond(['ok'=>true, 'return'=>['id'=>$returnId, 'returnNumber'=>$returnNumber, 'refundAmount'=>$refundTotal,
                'refundMethod'=>$refundMethod, 'refundStatus'=>$refundStatus, 'restockedProducts'=>$restockedNames]], 201);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    if ($method === 'POST' && $route === 'transactions') {
        $input = body();
        $items = $input['items'] ?? [];
        $voucherCode = $input['voucherCode'] ?? null;
        $methodName = strtoupper((string)($input['paymentMethod'] ?? 'CASH'));
        $cashReceived = (float)($input['cashReceived'] ?? 0);
        $customerName = $input['customerName'] ?? null;
        $customerEmail = $input['customerEmail'] ?? null;

        if (!is_array($items) || !$items) fail('The cart is empty.');
        if (!in_array($methodName, ['CASH','CARD','ONLINE'], true)) fail('Unsupported payment method.');
        $activeSettings = systemSettings($pdo);
        $methodEnabled = $methodName === 'CASH' ? (bool)$activeSettings['enable_cash'] : ($methodName === 'CARD' ? (bool)$activeSettings['enable_card'] : (bool)$activeSettings['enable_online']);
        if (!$methodEnabled) fail('That payment method is disabled in SaleSync Settings. Choose another payment method.', 422);

        $pdo->beginTransaction();
        try {
            $voucher = null;
            $voucherId = null;
            if ($voucherCode) {
                $voucher = one($pdo, "SELECT * FROM vouchers WHERE voucher_code=? AND is_active=TRUE
                    AND (starts_at IS NULL OR starts_at<=NOW()) AND (expires_at IS NULL OR expires_at>=NOW()) FOR UPDATE",
                    [strtoupper(trim((string)$voucherCode))]);
                if (!$voucher) throw new RuntimeException('Voucher is invalid or inactive.');
                $voucherId = (int)$voucher['voucher_id'];
                if ($voucher['usage_limit'] !== null && (int)$voucher['used_count'] >= (int)$voucher['usage_limit']) throw new RuntimeException('Voucher usage limit has been reached.');
            }

            $normalized = [];
            $subtotal = 0.0;
            foreach ($items as $raw) {
                $productId = filter_var($raw['productId'] ?? null, FILTER_VALIDATE_INT);
                $quantity = filter_var($raw['quantity'] ?? null, FILTER_VALIDATE_INT);
                if ($productId === false || $quantity === false || $quantity <= 0) throw new RuntimeException('Invalid cart item.');
                $p = one($pdo, "SELECT p.product_id, p.product_name, p.category_id, p.cost_price, p.selling_price,
                    i.quantity_on_hand, i.quantity_reserved FROM products p JOIN inventory i ON i.product_id=p.product_id
                    WHERE p.product_id=? AND p.is_active=TRUE FOR UPDATE", [$productId]);
                if (!$p) throw new RuntimeException("Product $productId was not found.");
                $available = (int)$p['quantity_on_hand'] - (int)$p['quantity_reserved'];
                if ($quantity > $available) throw new RuntimeException($p['product_name'] . " only has $available available.");
                $lineSubtotal = round((float)$p['selling_price'] * $quantity, 2);
                $subtotal += $lineSubtotal;
                $normalized[] = ['productId'=>$productId, 'categoryId'=>(int)$p['category_id'], 'name'=>$p['product_name'], 'quantity'=>$quantity,
                    'unitPrice'=>(float)$p['selling_price'], 'unitCost'=>(float)$p['cost_price'], 'lineSubtotal'=>$lineSubtotal];
            }
            $subtotal = round($subtotal, 2);

            $discount = 0.0;
            if ($voucher) {
                if ($subtotal < (float)$voucher['minimum_purchase']) throw new RuntimeException('Minimum purchase for ' . $voucher['voucher_code'] . ' is ₱' . number_format((float)$voucher['minimum_purchase'], 2) . '.');
                $discount = $voucher['discount_type'] === 'PERCENTAGE'
                    ? round($subtotal * ((float)$voucher['discount_value'] / 100), 2)
                    : min($subtotal, (float)$voucher['discount_value']);
            }
            $tax = round(($subtotal - $discount) * 0.12, 2);
            $total = round($subtotal - $discount + $tax, 2);
            if ($methodName === 'CASH' && $cashReceived < $total) throw new RuntimeException('Cash received must be at least ₱' . number_format($total, 2) . '.');
            $change = $methodName === 'CASH' ? round($cashReceived - $total, 2) : 0.0;

            $receipt = receiptNumber($pdo);
            $stmt = $pdo->prepare("INSERT INTO sales_transactions
                (receipt_number, source_channel, external_order_id, user_id, customer_name, customer_email,
                 subtotal, discount_amount, tax_amount, total_amount, status, voucher_id, completed_at)
                VALUES (?, 'PHYSICAL', NULL, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, NOW())");
            $stmt->execute([$receipt, $currentUser['user_id'], $customerName ?: null, $customerEmail ?: null,
                $subtotal, $discount, $tax, $total, $voucherId]);
            $transactionId = lastId($pdo);

            foreach ($normalized as $line) {
                $pct = $voucher && $voucher['discount_type'] === 'PERCENTAGE' ? (float)$voucher['discount_value'] / 100 : 0;
                $fixedShare = $voucher && $voucher['discount_type'] === 'FIXED' && $subtotal > 0 ? $discount * ($line['lineSubtotal'] / $subtotal) : 0;
                $lineDiscount = $voucher ? round($voucher['discount_type'] === 'PERCENTAGE' ? $line['lineSubtotal'] * $pct : $fixedShare, 2) : 0;
                $lineTotal = round($line['lineSubtotal'] - $lineDiscount, 2);
                execute($pdo, "INSERT INTO sale_items (transaction_id, product_id, category_id, quantity, unit_price, unit_cost, discount_amount, line_total)
                    VALUES (?,?,?,?,?,?,?,?)", [$transactionId, $line['productId'], $line['categoryId'], $line['quantity'], $line['unitPrice'], $line['unitCost'], $lineDiscount, $lineTotal]);

                $inv = one($pdo, 'SELECT quantity_on_hand FROM inventory WHERE product_id=? FOR UPDATE', [$line['productId']]);
                $before = (int)$inv['quantity_on_hand'];
                $after = $before - $line['quantity'];
                execute($pdo, 'UPDATE inventory SET quantity_on_hand=? WHERE product_id=?', [$after, $line['productId']]);
                execute($pdo, "INSERT INTO inventory_movements
                    (product_id, movement_type, quantity_change, quantity_before, quantity_after, reference_type, reference_id, reason, created_by)
                    VALUES (?, 'SALE', ?, ?, ?, 'SALE', ?, 'POS checkout sale', ?)",
                    [$line['productId'], -$line['quantity'], $before, $after, (string)$transactionId, $currentUser['user_id']]);
            }

            $paymentStatus = $methodName === 'ONLINE' ? ($config['allow_demo_online_payment'] ? 'PAID' : 'PENDING') : 'PAID';
            $paymentProvider = $methodName === 'ONLINE' ? 'PAYMONGO' : null;
            $paidAt = $paymentStatus === 'PAID' ? date('Y-m-d H:i:s') : null;
            $stmt = $pdo->prepare("INSERT INTO payments
                (transaction_id, payment_method, payment_provider, amount, status, cash_received, change_amount, paid_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            $stmt->execute([$transactionId, $methodName, $paymentProvider, $total, $paymentStatus,
                $methodName === 'CASH' ? $cashReceived : null, $methodName === 'CASH' ? $change : null, $paidAt]);
            $paymentId = lastId($pdo);

            if ($voucherId) execute($pdo, 'UPDATE vouchers SET used_count=used_count+1 WHERE voucher_id=?', [$voucherId]);
            execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value)
                VALUES (?, 'CREATE_TRANSACTION', 'SALE', ?, ?)",
                [$currentUser['user_id'], (string)$transactionId, json_encode(['receipt_number'=>$receipt,'total_amount'=>$total,'payment_method'=>$methodName])]);

            $pdo->commit();

            $itemRows = query($pdo, "SELECT si.quantity, si.unit_price, si.line_total, p.product_name
                FROM sale_items si JOIN products p ON p.product_id=si.product_id WHERE si.transaction_id=? ORDER BY si.sale_item_id", [$transactionId]);
            $tx = ['id'=>$transactionId, 'receiptNumber'=>$receipt, 'time'=>date(DATE_ATOM), 'sourceChannel'=>'PHYSICAL',
                'subtotal'=>$subtotal, 'discount'=>$discount, 'tax'=>$tax, 'total'=>$total,
                'payMethod'=>$methodName === 'ONLINE' ? 'paymongo' : strtolower($methodName), 'paymentStatus'=>$paymentStatus, 'cashGiven'=>$cashReceived,
                'change'=>$change, 'voucher'=>$voucher['voucher_code'] ?? null,
                'lines'=>array_map(fn($i)=>['name'=>$i['product_name'],'qty'=>(int)$i['quantity'],'price'=>(float)$i['unit_price'],'lineTotal'=>(float)$i['line_total']], $itemRows)];
            respond(['ok'=>true, 'transaction'=>$tx, 'paymentId'=>$paymentId], 201);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    if ($method === 'POST' && count($parts) === 3 && $parts[0] === 'transactions' && $parts[2] === 'digital-receipt') {
        $transactionId = filter_var($parts[1], FILTER_VALIDATE_INT);
        $input = body();
        $email = trim((string)($input['email'] ?? ''));
        if ($transactionId === false || !filter_var($email, FILTER_VALIDATE_EMAIL)) fail('A valid email address is required.');
        execute($pdo, "INSERT INTO digital_receipts (transaction_id, recipient_email, delivery_status) VALUES (?, ?, 'PENDING')", [$transactionId, $email]);
        respond(['ok'=>true, 'status'=>'PENDING', 'message'=>'Digital receipt request recorded. Email delivery is not configured yet.']);
    }

    fail('API endpoint not found.', 404);
} catch (Throwable $e) {
    fail($e->getMessage(), 400);
}
