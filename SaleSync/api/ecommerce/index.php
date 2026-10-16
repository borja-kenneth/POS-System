<?php
declare(strict_types=1);

// Private server-to-server API for ShopHub. It is deliberately separate from
// SaleSync's cashier/admin API and never exposes its shared key to the browser.
header('Content-Type: application/json; charset=utf-8');

$databaseConfig = require dirname(__DIR__) . '/config.php';
$localConfigPath = __DIR__ . '/config.local.php';
$bridgeConfig = is_file($localConfigPath) ? require $localConfigPath : ['api_key' => ''];
$expectedKey = (string)($bridgeConfig['api_key'] ?? '');

function reply(array $data, int $status = 200): never {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $status = 400): never {
    reply(['error' => $message], $status);
}

function requestBody(): array {
    $raw = file_get_contents('php://input');
    if (strlen($raw) > 1000000) fail('Request is too large.', 413);
    $data = json_decode($raw ?: '{}', true);
    if (!is_array($data)) fail('Request must contain valid JSON.');
    return $data;
}

function db(array $config): PDO {
    $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
        $config['host'], $config['port'], $config['database']);
    return new PDO($dsn, $config['username'], $config['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
}

function rows(PDO $pdo, string $sql, array $values = []): array {
    $stmt = $pdo->prepare($sql);
    $stmt->execute($values);
    return $stmt->fetchAll();
}

function one(PDO $pdo, string $sql, array $values = []): ?array {
    return rows($pdo, $sql, $values)[0] ?? null;
}

function execSql(PDO $pdo, string $sql, array $values = []): int {
    $stmt = $pdo->prepare($sql);
    $stmt->execute($values);
    return $stmt->rowCount();
}

function money(mixed $value, string $label): float {
    if (!is_numeric($value)) fail("Invalid $label.");
    $number = round((float)$value, 2);
    if (!is_finite($number) || $number < 0 || $number > 9999999999.99) fail("Invalid $label.");
    return $number;
}

function inventoryMove(PDO $pdo, int $productId, string $type, int $qty, string $orderNumber, ?int $userId = null): void {
    $stock = one($pdo, 'SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE product_id=? FOR UPDATE', [$productId]);
    if (!$stock) throw new RuntimeException('Inventory record is missing.');
    $onHand = (int)$stock['quantity_on_hand'];
    $reserved = (int)$stock['quantity_reserved'];
    if ($type === 'RESERVATION') {
        if ($onHand - $reserved < $qty) throw new DomainException('There is not enough stock for one or more items.');
        execSql($pdo, 'UPDATE inventory SET quantity_reserved=quantity_reserved+? WHERE product_id=?', [$qty, $productId]);
        execSql($pdo, "INSERT INTO inventory_movements (product_id,movement_type,quantity_change,quantity_before,quantity_after,reference_type,reference_id,reason,created_by)
            VALUES (?,'RESERVATION',?,?,?,?,?,'ShopHub order reserved',?)", [$productId,$qty,$reserved,$reserved+$qty,'ECOMMERCE_ORDER',$orderNumber,$userId]);
        return;
    }
    if ($type === 'RELEASE') {
        if ($reserved < $qty) throw new RuntimeException('The order reservation does not match inventory.');
        execSql($pdo, 'UPDATE inventory SET quantity_reserved=quantity_reserved-? WHERE product_id=?', [$qty, $productId]);
        execSql($pdo, "INSERT INTO inventory_movements (product_id,movement_type,quantity_change,quantity_before,quantity_after,reference_type,reference_id,reason,created_by)
            VALUES (?,'RELEASE',?,?,?,?,?,'ShopHub reservation released',?)", [$productId,-$qty,$reserved,$reserved-$qty,'ECOMMERCE_ORDER',$orderNumber,$userId]);
        return;
    }
    if ($type === 'SALE') {
        if ($onHand < $qty) throw new RuntimeException('There is not enough physical stock to complete this order.');
        execSql($pdo, 'UPDATE inventory SET quantity_on_hand=quantity_on_hand-? WHERE product_id=?', [$qty, $productId]);
        execSql($pdo, "INSERT INTO inventory_movements (product_id,movement_type,quantity_change,quantity_before,quantity_after,reference_type,reference_id,reason,created_by)
            VALUES (?,'SALE',?,?,?,?,?,'ShopHub delivery completed',?)", [$productId,-$qty,$onHand,$onHand-$qty,'ECOMMERCE_ORDER',$orderNumber,$userId]);
    }
}

function recordOrder(PDO $pdo, array $input): array {
    $groups = $input['groups'] ?? null;
    if (!is_array($groups) || !$groups) fail('The order has no items.');
    $address = $input['address'] ?? [];
    $name = trim((string)($address['name'] ?? ''));
    $email = trim((string)($input['customerEmail'] ?? ''));
    if ($name === '' || mb_strlen($name) > 150) fail('Enter a valid customer name.');
    if ($email === '' || mb_strlen($email) > 150 || !filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Enter a valid customer email.');
    if (($input['paymentMethod'] ?? '') !== 'Cash on Delivery') fail('The SaleSync connection currently accepts Cash on Delivery orders only.', 422);

    $pdo->beginTransaction();
    try {
        $saved = [];
        foreach ($groups as $group) {
            $orderNumber = trim((string)($group['orderNumber'] ?? ''));
            if (!preg_match('/^ORD-\d{4,}$/D', $orderNumber)) fail('The order number is invalid.');
            $existing = one($pdo, 'SELECT order_number,status FROM ecommerce_orders WHERE order_number=? FOR UPDATE', [$orderNumber]);
            if ($existing) {
                if ($existing['status'] === 'RESERVED') { $saved[] = ['orderNumber'=>$orderNumber,'status'=>'RESERVED']; continue; }
                throw new DomainException('This order number was already used.');
            }
            $items = $group['items'] ?? null;
            if (!is_array($items) || !$items) fail('An order has no items.');
            $productIds = [];
            foreach ($items as $item) {
                $pid = filter_var($item['productId'] ?? null, FILTER_VALIDATE_INT);
                $qty = filter_var($item['quantity'] ?? null, FILTER_VALIDATE_INT);
                if (!$pid || !$qty || $qty < 1 || $qty > 99) fail('A product or quantity is invalid.');
                $productIds[] = $pid;
            }
            $productIds = array_values(array_unique($productIds));
            sort($productIds, SORT_NUMERIC);
            $products = [];
            foreach ($productIds as $pid) {
                $product = one($pdo, "SELECT p.product_id,p.product_name,p.category_id,p.cost_price,p.selling_price,i.quantity_on_hand,i.quantity_reserved
                    FROM products p JOIN inventory i ON i.product_id=p.product_id WHERE p.product_id=? AND p.is_active=TRUE FOR UPDATE", [$pid]);
                if (!$product) throw new DomainException('A selected product is no longer available.');
                $products[$pid] = $product;
            }
            $subtotal = 0.0;
            $lines = [];
            foreach ($items as $item) {
                $pid = (int)$item['productId'];
                $qty = (int)$item['quantity'];
                $product = $products[$pid];
                if ((int)$product['quantity_on_hand'] - (int)$product['quantity_reserved'] < $qty) throw new DomainException($product['product_name'] . ' does not have enough available stock.');
                $price = (float)$product['selling_price'];
                $subtotal += $price * $qty;
                $lines[] = ['product'=>$product,'quantity'=>$qty,'price'=>$price,'cost'=>(float)$product['cost_price'],'lineSubtotal'=>$price*$qty];
            }
            $subtotal = round($subtotal, 2);
            $itemDiscount = money($group['itemDiscount'] ?? 0, 'discount');
            $shipping = money($group['shippingFee'] ?? 0, 'shipping fee');
            $shippingDiscount = money($group['shippingDiscount'] ?? 0, 'shipping discount');
            if ($itemDiscount > $subtotal || $shippingDiscount > $shipping) fail('The order discount is larger than its total.');
            $total = round($subtotal - $itemDiscount + $shipping - $shippingDiscount, 2);
            execSql($pdo, "INSERT INTO ecommerce_orders (order_number,customer_name,customer_email,subtotal,item_discount,shipping_fee,shipping_discount,total_amount,status)
                VALUES (?,?,?,?,?,?,?,?,'RESERVED')", [$orderNumber,$name,$email,$subtotal,$itemDiscount,$shipping,$shippingDiscount,$total]);
            $discountLeft = $itemDiscount;
            $subtotalLeft = $subtotal;
            foreach ($lines as $index => $line) {
                $share = $index === count($lines)-1 ? $discountLeft : ($subtotal > 0 ? round($itemDiscount * $line['lineSubtotal'] / $subtotal, 2) : 0);
                $share = min($share, $discountLeft, $line['lineSubtotal']);
                $discountLeft = round($discountLeft - $share, 2);
                execSql($pdo, 'INSERT INTO ecommerce_order_items (order_number,product_id,quantity,unit_price,unit_cost,item_discount) VALUES (?,?,?,?,?,?)',
                    [$orderNumber,(int)$line['product']['product_id'],$line['quantity'],$line['price'],$line['cost'],$share]);
                inventoryMove($pdo, (int)$line['product']['product_id'], 'RESERVATION', $line['quantity'], $orderNumber);
                $subtotalLeft -= $line['lineSubtotal'];
            }
            $saved[] = ['orderNumber'=>$orderNumber,'status'=>'RESERVED','total'=>$total];
        }
        $pdo->commit();
        return ['ok'=>true,'orders'=>$saved];
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

function updateOrder(PDO $pdo, string $orderNumber, string $action): array {
    $pdo->beginTransaction();
    try {
        $order = one($pdo, 'SELECT * FROM ecommerce_orders WHERE order_number=? FOR UPDATE', [$orderNumber]);
        if (!$order) throw new DomainException('The ShopHub order was not found.');
        if ($action === 'cancel') {
            if ($order['status'] === 'CANCELLED') { $pdo->commit(); return ['ok'=>true,'status'=>'CANCELLED']; }
            if ($order['status'] !== 'RESERVED') throw new DomainException('Only a reserved order can be cancelled.');
            $items = rows($pdo, 'SELECT product_id,quantity FROM ecommerce_order_items WHERE order_number=? ORDER BY product_id FOR UPDATE', [$orderNumber]);
            foreach ($items as $item) inventoryMove($pdo,(int)$item['product_id'],'RELEASE',(int)$item['quantity'],$orderNumber);
            execSql($pdo, "UPDATE ecommerce_orders SET status='CANCELLED' WHERE order_number=?", [$orderNumber]);
            $pdo->commit();
            return ['ok'=>true,'status'=>'CANCELLED'];
        }
        if ($action !== 'complete') throw new DomainException('Unknown order action.');
        if ($order['status'] === 'COMPLETED') { $pdo->commit(); return ['ok'=>true,'status'=>'COMPLETED','transactionId'=>(int)$order['transaction_id']]; }
        if ($order['status'] !== 'RESERVED') throw new DomainException('Only a reserved order can be completed.');
        $items = rows($pdo, 'SELECT oi.*,p.category_id,p.product_name FROM ecommerce_order_items oi JOIN products p ON p.product_id=oi.product_id WHERE oi.order_number=? ORDER BY oi.product_id FOR UPDATE', [$orderNumber]);
        if (!$items) throw new RuntimeException('The order has no saved item lines.');

        $settings = one($pdo, 'SELECT receipt_prefix FROM system_settings WHERE settings_id=1');
        $receipt = (string)($settings['receipt_prefix'] ?? 'POS') . '-WEB-' . $orderNumber;
        $discount = round((float)$order['item_discount'] + (float)$order['shipping_discount'], 2);
        $notes = 'ShopHub order ' . $orderNumber . '; shipping ' . number_format((float)$order['shipping_fee'] - (float)$order['shipping_discount'], 2, '.', '') . ' PHP';
        execSql($pdo, "INSERT INTO sales_transactions (receipt_number,source_channel,external_order_id,customer_name,customer_email,subtotal,discount_amount,tax_amount,total_amount,status,notes,completed_at)
            VALUES (?,'ECOMMERCE',?,?,?,?,?,?,?,'COMPLETED',?,NOW())", [$receipt,$orderNumber,$order['customer_name'],$order['customer_email'],$order['subtotal'],$discount,0,$order['total_amount'],$notes]);
        $transactionId = (int)$pdo->lastInsertId();
        foreach ($items as $item) {
            $lineTotal = round((float)$item['unit_price'] * (int)$item['quantity'] - (float)$item['item_discount'], 2);
            execSql($pdo, 'INSERT INTO sale_items (transaction_id,product_id,category_id,quantity,unit_price,unit_cost,discount_amount,line_total) VALUES (?,?,?,?,?,?,?,?)',
                [$transactionId,(int)$item['product_id'],(int)$item['category_id'],(int)$item['quantity'],$item['unit_price'],$item['unit_cost'],$item['item_discount'],$lineTotal]);
            inventoryMove($pdo,(int)$item['product_id'],'RELEASE',(int)$item['quantity'],$orderNumber);
            inventoryMove($pdo,(int)$item['product_id'],'SALE',(int)$item['quantity'],$orderNumber);
        }
        execSql($pdo, "INSERT INTO payments (transaction_id,payment_method,amount,status,cash_received,change_amount,paid_at)
            VALUES (?,'CASH',?,'PAID',?,0,NOW())", [$transactionId,$order['total_amount'],$order['total_amount']]);
        execSql($pdo, "INSERT INTO audit_logs (action,entity_type,entity_id,new_value) VALUES ('ECOMMERCE_ORDER_COMPLETED','SALE',?,?)",
            [(string)$transactionId,json_encode(['orderNumber'=>$orderNumber,'source'=>'ShopHub'])]);
        execSql($pdo, "UPDATE ecommerce_orders SET status='COMPLETED',transaction_id=?,completed_at=NOW() WHERE order_number=?", [$transactionId,$orderNumber]);
        $pdo->commit();
        return ['ok'=>true,'status'=>'COMPLETED','transactionId'=>$transactionId,'receiptNumber'=>$receipt];
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

if ($expectedKey === '' || $expectedKey === 'replace-with-a-long-random-secret') fail('SaleSync e-commerce API key is not configured.', 503);
$providedKey = (string)($_SERVER['HTTP_X_SALESYNC_KEY'] ?? '');
if ($providedKey === '' || !hash_equals($expectedKey, $providedKey)) fail('Not authorized.', 401);

$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$route = trim((string)($_GET['route'] ?? ''), '/');
try {
    $pdo = db($databaseConfig);
    if ($method === 'GET' && $route === 'health') {
        rows($pdo, 'SELECT 1');
        reply(['ok'=>true,'database'=>'salesync']);
    }
    if ($method === 'GET' && $route === 'catalog') {
        $products = rows($pdo, "SELECT p.product_id,p.product_name,p.barcode,p.category_id,c.category_name,p.selling_price,
            i.quantity_on_hand,i.quantity_reserved,(i.quantity_on_hand-i.quantity_reserved) AS available_quantity,
            epm.seller_id,epm.seller_email,epm.seller_name,epm.original_price,epm.image,epm.description
            FROM products p JOIN categories c ON c.category_id=p.category_id JOIN inventory i ON i.product_id=p.product_id
            LEFT JOIN ecommerce_product_metadata epm ON epm.product_id=p.product_id
            WHERE p.is_active=TRUE ORDER BY p.product_id");
        $categories = rows($pdo, 'SELECT category_id,category_name FROM categories WHERE is_active=TRUE ORDER BY category_name');
        $settings = one($pdo, 'SELECT store_name FROM system_settings WHERE settings_id=1');
        reply(['ok'=>true,'storeName'=>$settings['store_name'] ?? 'SaleSync Store',
            'products'=>array_map(static fn($p)=>['product_id'=>(int)$p['product_id'],'name'=>$p['product_name'],'sku'=>(string)($p['barcode'] ?: $p['product_id']),
                'category_id'=>(int)$p['category_id'],'category_name'=>$p['category_name'],'price'=>(float)$p['selling_price'],
                'original_price'=>(float)($p['original_price'] ?? $p['selling_price']),
                'seller_id'=>$p['seller_id'] ?? 'salesync-store','seller_email'=>$p['seller_email'] ?? null,
                'seller_name'=>$p['seller_name'] ?? ($settings['store_name'] ?? 'SaleSync Store'),
                'stock'=>(int)$p['available_quantity'],'image'=>($p['image'] ?: '📦'),'rating_avg'=>0,'review_count'=>0,'description'=>($p['description'] ?? 'Available from the SaleSync store.')], $products),
            'categories'=>array_map(static fn($c)=>['id'=>(int)$c['category_id'],'name'=>$c['category_name']],$categories)]);
    }
    if ($method === 'POST' && $route === 'products') {
        $input = requestBody();
        $product = $input['product'] ?? [];
        $seller = $input['seller'] ?? [];
        $name = trim((string)($product['name'] ?? ''));
        $barcode = strtoupper(trim((string)($product['sku'] ?? '')));
        $categoryName = trim((string)($product['category'] ?? ''));
        $price = money($product['price'] ?? null, 'price');
        $originalPrice = money($product['originalPrice'] ?? $price, 'original price');
        $stock = filter_var($product['stock'] ?? null, FILTER_VALIDATE_INT);
        $sellerId = trim((string)($seller['id'] ?? ''));
        $sellerEmail = strtolower(trim((string)($seller['email'] ?? '')));
        $sellerName = trim((string)($seller['storeName'] ?? ''));
        $image = trim((string)($product['image'] ?? '📦'));
        $description = trim((string)($product['description'] ?? ''));

        if ($name === '' || mb_strlen($name) > 150) fail('Product name is required and must be 150 characters or fewer.');
        if ($barcode === '' || mb_strlen($barcode) > 64 || !preg_match('/^[A-Z0-9 .\/\$+%-]+$/D', $barcode)) {
            fail('Barcode must use A-Z, 0-9, spaces, and - . $ / + % only.');
        }
        if ($price <= 0) fail('Product price must be greater than zero.');
        if ($stock === false || $stock < 0) fail('Stock must be a whole number of zero or more.');
        if ($sellerId === '' || $sellerName === '' || !filter_var($sellerEmail, FILTER_VALIDATE_EMAIL)) fail('Seller information is invalid.');
        if (mb_strlen($sellerName) > 150 || mb_strlen($sellerEmail) > 150 || mb_strlen($image) > 255) fail('Seller or image information is too long.');
        if (one($pdo, 'SELECT product_id FROM products WHERE barcode=?', [$barcode])) fail('That barcode is already assigned to another product.', 409);
        $category = one($pdo, 'SELECT category_id FROM categories WHERE category_name=? AND is_active=TRUE', [$categoryName]);
        if (!$category) fail('Choose an active SaleSync category.');

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('INSERT INTO products (product_name,barcode,category_id,cost_price,selling_price,reorder_point) VALUES (?,?,?,0,?,10)');
            $stmt->execute([$name,$barcode,(int)$category['category_id'],$price]);
            $productId = (int)$pdo->lastInsertId();
            execSql($pdo, 'INSERT INTO inventory (product_id,quantity_on_hand,quantity_reserved) VALUES (?,?,0)', [$productId,$stock]);
            if ($stock > 0) {
                execSql($pdo, "INSERT INTO inventory_movements
                    (product_id,movement_type,quantity_change,quantity_before,quantity_after,reference_type,reference_id,reason)
                    VALUES (?,'RESTOCK',?,0,?,'SHOPHUB_PRODUCT',?,'Opening stock from ShopHub')",
                    [$productId,$stock,$stock,(string)$productId]);
            }
            execSql($pdo, 'INSERT INTO ecommerce_product_metadata (product_id,seller_id,seller_email,seller_name,original_price,image,description) VALUES (?,?,?,?,?,?,?)',
                [$productId,$sellerId,$sellerEmail,$sellerName,max($price,$originalPrice),$image ?: '📦',$description]);
            execSql($pdo, "INSERT INTO audit_logs (action,entity_type,entity_id,new_value) VALUES ('SHOPHUB_CREATE_PRODUCT','PRODUCT',?,?)",
                [(string)$productId,json_encode(['name'=>$name,'seller'=>$sellerEmail,'sku'=>$barcode],JSON_UNESCAPED_UNICODE)]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
        reply(['ok'=>true,'productId'=>$productId,'sku'=>$barcode],201);
    }
    if ($method === 'POST' && $route === 'orders') reply(recordOrder($pdo, requestBody()), 201);
    if ($method === 'POST' && preg_match('~^orders/(ORD-\d{4,})/(complete|cancel)$~D', $route, $match)) {
        reply(updateOrder($pdo,$match[1],$match[2]));
    }
    fail('Endpoint not found.', 404);
} catch (DomainException $e) {
    fail($e->getMessage(), 409);
} catch (Throwable $e) {
    error_log('SaleSync e-commerce API: ' . $e->getMessage());
    fail('SaleSync could not process the e-commerce request.', 500);
}
