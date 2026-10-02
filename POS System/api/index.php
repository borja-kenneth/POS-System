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

function receiptNumber(): string {
    $now = new DateTimeImmutable('now');
    return sprintf('POS-%s-%s-%02d', $now->format('Ymd'), substr((string)round(microtime(true) * 1000), -6), random_int(10, 99));
}

function asProduct(array $row): array {
    return [
        'id' => (string)(int)$row['product_id'],
        'productId' => (int)$row['product_id'],
        'name' => $row['product_name'],
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

function getBootstrap(PDO $pdo): array {
    $products = query($pdo, "SELECT p.product_id, p.sku, p.product_name, p.category_id, c.category_name,
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

    $ledger = query($pdo, "SELECT transaction_id, receipt_number, transaction_date, source_channel, sku,
        product_name, category_name, quantity, unit_price, unit_cost, total, gross_profit, status
        FROM vw_sales_ledger WHERE transaction_date >= DATE_SUB(CURDATE(), INTERVAL 89 DAY)
        ORDER BY transaction_date DESC, transaction_id DESC");

    $transactions = query($pdo, "SELECT st.transaction_id, st.receipt_number, st.source_channel, st.external_order_id,
        st.customer_name, st.customer_email, st.subtotal, st.discount_amount, st.tax_amount, st.total_amount,
        st.status, st.voucher_id, st.created_at, st.completed_at,
        p.payment_method, p.payment_provider, p.provider_payment_id,
        p.status AS payment_status, p.amount AS payment_amount, p.cash_received, p.change_amount,
        v.voucher_code
        FROM sales_transactions st
        LEFT JOIN payments p ON p.transaction_id = st.transaction_id
        LEFT JOIN vouchers v ON v.voucher_id = st.voucher_id
        WHERE st.status = 'COMPLETED'
        ORDER BY st.transaction_id DESC LIMIT 100");

    $expenses = query($pdo, "SELECT expense_category, amount, expense_date FROM expenses ORDER BY expense_date DESC, expense_id DESC");

    $ids = array_map(fn($r) => (int)$r['transaction_id'], $transactions);
    $itemRows = [];
    if ($ids) {
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $itemRows = query($pdo, "SELECT si.transaction_id, si.product_id, p.sku, p.product_name,
            si.quantity, si.unit_price, si.unit_cost, si.discount_amount, si.line_total
            FROM sale_items si JOIN products p ON p.product_id = si.product_id
            WHERE si.transaction_id IN ($placeholders)
            ORDER BY si.transaction_id DESC, si.sale_item_id ASC", $ids);
    }

    $itemsByTx = [];
    foreach ($itemRows as $item) {
        $id = (int)$item['transaction_id'];
        $itemsByTx[$id][] = [
            'name' => $item['product_name'], 'sku' => $item['sku'], 'qty' => (int)$item['quantity'],
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
            'payMethod' => strtolower((string)($t['payment_method'] ?: 'cash')),
            'paymentStatus' => $t['payment_status'], 'cashGiven' => (float)($t['cash_received'] ?: 0),
            'change' => (float)($t['change_amount'] ?: 0), 'voucher' => $t['voucher_code'],
            'lines' => $itemsByTx[$id] ?? []
        ];
    }, $transactions);

    $expenseTotals = [];
    foreach ($expenses as $e) {
        $expenseTotals[$e['expense_category']] = (float)$e['amount'];
    }

    return [
        'products' => array_map('asProduct', $products),
        'categories' => $categoriesMap,
        'vouchers' => $voucherMap,
        'sales' => array_map(fn($r) => [
            'date' => date('Y-m-d', strtotime($r['transaction_date'])),
            'transactionId' => (int)$r['transaction_id'], 'receiptNumber' => $r['receipt_number'],
            'sourceChannel' => $r['source_channel'], 'sku' => $r['sku'], 'name' => $r['product_name'],
            'cat' => $r['category_name'], 'qty' => (int)$r['quantity'], 'price' => (float)$r['unit_price'],
            'cost' => (float)$r['unit_cost'], 'total' => (float)$r['total'], 'profit' => (float)$r['gross_profit']
        ], $ledger),
        'transactions' => $txs,
        'expenses' => $expenseTotals
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

    if ($method === 'PUT' && count($parts) === 2 && $parts[0] === 'products') {
        requireRole($currentUser, 'ADMIN');
        $productId = filter_var($parts[1], FILTER_VALIDATE_INT);
        $input = body();
        if ($productId === false) fail('Invalid product id.');
        $categoryId = filter_var($input['categoryId'] ?? null, FILTER_VALIDATE_INT);
        $costPrice = (float)($input['costPrice'] ?? 0);
        $sellingPrice = (float)($input['sellingPrice'] ?? 0);
        $reorderPoint = filter_var($input['reorderPoint'] ?? null, FILTER_VALIDATE_INT);
        if ($categoryId === false) fail('Invalid category.');
        if ($costPrice < 0 || $sellingPrice < 0 || $reorderPoint === false || $reorderPoint < 0) fail('Values cannot be negative.');

        execute($pdo, 'UPDATE products SET category_id=?, cost_price=?, selling_price=?, reorder_point=? WHERE product_id=?',
            [$categoryId, $costPrice, $sellingPrice, $reorderPoint, $productId]);
        execute($pdo, "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value)
            VALUES (?, 'UPDATE_PRODUCT', 'PRODUCT', ?, ?)",
            [$currentUser['user_id'], (string)$productId, json_encode(compact('categoryId','costPrice','sellingPrice','reorderPoint'))]);
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
        $reorderPoint = filter_var($input['reorderPoint'] ?? 10, FILTER_VALIDATE_INT);
        $openingStock = filter_var($input['openingStock'] ?? 0, FILTER_VALIDATE_INT);
        if (!$productName || $categoryId === false) fail('Product name and category are required.');
        if ($costPrice < 0 || $sellingPrice < 0 || $reorderPoint === false || $reorderPoint < 0 || $openingStock === false || $openingStock < 0) fail('Values cannot be negative.');

        $pdo->beginTransaction();
        $internalCode = 'P-' . bin2hex(random_bytes(8));
        $stmt = $pdo->prepare('INSERT INTO products (sku, product_name, category_id, cost_price, selling_price, reorder_point) VALUES (?,?,?,?,?,?)');
        $stmt->execute([$internalCode, $productName, $categoryId, $costPrice, $sellingPrice, $reorderPoint]);
        $productId = lastId($pdo);
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
        respond(['ok'=>true, 'productId'=>$productId], 201);
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
                $p = one($pdo, "SELECT p.product_id, p.sku, p.product_name, p.cost_price, p.selling_price,
                    i.quantity_on_hand, i.quantity_reserved FROM products p JOIN inventory i ON i.product_id=p.product_id
                    WHERE p.product_id=? AND p.is_active=TRUE FOR UPDATE", [$productId]);
                if (!$p) throw new RuntimeException("Product $productId was not found.");
                $available = (int)$p['quantity_on_hand'] - (int)$p['quantity_reserved'];
                if ($quantity > $available) throw new RuntimeException($p['product_name'] . " only has $available available.");
                $lineSubtotal = round((float)$p['selling_price'] * $quantity, 2);
                $subtotal += $lineSubtotal;
                $normalized[] = ['productId'=>$productId, 'sku'=>$p['sku'], 'name'=>$p['product_name'], 'quantity'=>$quantity,
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

            $receipt = receiptNumber();
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
                execute($pdo, "INSERT INTO sale_items (transaction_id, product_id, quantity, unit_price, unit_cost, discount_amount, line_total)
                    VALUES (?,?,?,?,?,?,?)", [$transactionId, $line['productId'], $line['quantity'], $line['unitPrice'], $line['unitCost'], $lineDiscount, $lineTotal]);

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

            $itemRows = query($pdo, "SELECT si.quantity, si.unit_price, si.line_total, p.product_name, p.sku
                FROM sale_items si JOIN products p ON p.product_id=si.product_id WHERE si.transaction_id=? ORDER BY si.sale_item_id", [$transactionId]);
            $tx = ['id'=>$transactionId, 'receiptNumber'=>$receipt, 'time'=>date(DATE_ATOM), 'sourceChannel'=>'PHYSICAL',
                'subtotal'=>$subtotal, 'discount'=>$discount, 'tax'=>$tax, 'total'=>$total,
                'payMethod'=>strtolower($methodName), 'paymentStatus'=>$paymentStatus, 'cashGiven'=>$cashReceived,
                'change'=>$change, 'voucher'=>$voucher['voucher_code'] ?? null,
                'lines'=>array_map(fn($i)=>['name'=>$i['product_name'],'sku'=>$i['sku'],'qty'=>(int)$i['quantity'],'price'=>(float)$i['unit_price'],'lineTotal'=>(float)$i['line_total']], $itemRows)];
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
