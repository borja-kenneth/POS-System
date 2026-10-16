SaleSync — PHP + MariaDB / XAMPP
================================

REQUIREMENTS
- XAMPP with Apache and MySQL/MariaDB running
- PHP extensions enabled as shipped with XAMPP (PDO MySQL; mbstring recommended)
- A modern browser. Camera access requires localhost or HTTPS plus browser permission.

FRESH / DEMO INSTALLATION
1. Extract the SaleSync folder into C:\xampp\htdocs\SaleSync\ (or another folder under htdocs).
2. Start Apache and MySQL in XAMPP.
3. Open phpMyAdmin at http://localhost/phpmyadmin/.
4. Import database\salesync_database.sql using phpMyAdmin > salesync > Import. This single SQL file is tailored for MariaDB 10.4.32 and creates the complete schema, demo accounts/sample data, settings, return/refund features, indexes, and reporting views. Your current SHOW TABLES output was empty, so treat this as a fresh install.
5. The SQL file does not DROP tables or operational rows, but it is intended for an empty/new schema. If you later use an older non-empty SaleSync database, back it up and use an upgrade migration instead. Import the .sql file in phpMyAdmin rather than pasting thousands of lines into the MariaDB console. After import, check the table/view list shown by the final verification query.
6. Confirm api\config.php points to the `salesync` database (default XAMPP user is root with a blank password unless yours is configured differently).
7. Open http://localhost/SaleSync/login.html. If you used a different folder name, use that folder name in the URL.
8. Optional health check: http://localhost/SaleSync/api/index.php?route=health . Expected JSON includes {"ok":true,"database":"salesync"}.

SHOPHUB CONNECTION (OPTIONAL, TWO COMPUTERS)
1. With the SaleSync database imported and XAMPP running, import api\ecommerce\schema.sql into the existing `salesync` database once. It adds only ShopHub order/reservation tracking tables.
2. Copy api\ecommerce\config.example.php to api\ecommerce\config.local.php and set a long random `api_key`. Keep this private. ShopHub's server\.env must contain the exact same key.
3. On the SaleSync computer, use `ipconfig` to find its Wi-Fi/Ethernet IPv4 address. The ShopHub computer must use that address, not `localhost`, in `SALESYNC_API_URL`.
4. Allow Apache through Windows Firewall on Private networks if prompted. Keep both computers on the same trusted local network; do not expose the connector to the public internet.
5. In ShopHub's server\.env, set `SALESYNC_API_URL=http://<SaleSync-IP>/SaleSync/api/ecommerce/index.php` and `SALESYNC_API_KEY=<the-same-secret>`.
6. ShopHub reads this POS's product list and stock. A placed order reserves stock; an uncompleted cancellation releases it. Marking delivery Completed consumes the stock and saves a SaleSync transaction marked ECOMMERCE. The first connector version accepts Cash on Delivery only.

DEMO ACCOUNTS
- Admin: admin / admin123
- Cashier: cashier / cashier123

FEATURES
- Admin Settings page: store profile, receipt footer, currency symbol, date format, timezone, default stock warning, product barcode prefix, receipt prefix, return period, payment-method availability, refund options, and settings export, and administrator password change.
- Settings persist in MariaDB and are protected by Admin role checks. High-level settings changes and admin password changes are written to the audit log; password values are not logged. If an earlier SQL import stored the currency symbol as a question mark or another unsupported value, the API repairs it to the Philippine peso symbol automatically when settings load; no database re-import is needed.
- Checkout Scan Mode takes over the left product panel while leaving Current Sale visible on the right. Scan multiple items without reopening the scanner. Successful camera scans have a 900 ms cooldown, and a code must leave the camera view for about 900 ms before the same label can be scanned again. This prevents a barcode held in front of the camera from rapidly increasing quantity; remove and present it again to scan another unit.
- Native camera detection supports whatever QR/barcode formats the browser advertises. Local fallback supports SaleSync-generated QR labels and Code 39; manual entry remains available.
- Barcode labels support QR or Code 39, preview, PNG download, and printing 1–200 copies.
- Category Management, Daily Sales category filtering, cashier receipt search, and Return / Refund stay available.
- System feedback and confirmations use SaleSync in-app popup dialogs, including Return / Refund completion, checkout errors, invalid vouchers, barcode-label errors, product errors, and expense deletion confirmation. No native browser alert/confirm/prompt dialogs are used.
- Return period and refund-method options are validated by the PHP API, not only hidden in the interface.
- PayMongo provider refunds are not automatically submitted by this version. Original-method refund records can be pending/manual.

QUICK TEST CHECKLIST
1. Login as Admin and open Settings. Change the store name, currency symbol, barcode prefix, and receipt footer; save; refresh; confirm they persist.
2. Disable Card or Online and confirm its checkout button disappears. Confirm at least one payment method stays enabled.
3. Add a new product with a blank barcode; confirm the configured prefix is used on the generated label.
4. Open Checkout, click Scan, and verify the left panel switches to Scan Mode while Current Sale remains on the right. Scan labels with a short pause between reads; keep a single label in view to confirm it adds only once until it is removed and presented again. The scanner should stay open and the cart should update.
5. Search a receipt as Cashier and open Return / Refund. Test the configured return-period limit and default restock setting.
6. This SQL file is for MariaDB 10.4.32 fresh setup and is safe to re-run for the same schema, but is not a general migration tool for an older schema. Back up the database before any future upgrade.

SECURITY NOTES
- Never store card numbers, CVV, or PayMongo secret keys in client-side JavaScript or ordinary database fields.
- Keep regular database backups in a location separate from the computer running SaleSync.

STARTUP LOOP / LOADING TROUBLESHOOTING
- The app now sends users to login only when the API explicitly reports no active session.
- If the session is valid but the API or database fails during data loading, SaleSync shows a retry screen instead of bouncing between index.html and login.html.
- If this screen appears, start Apache and MySQL, verify the salesync database import, and open http://localhost/SaleSync/api/index.php?route=health. Then click Retry.
