Til·POS — XAMPP UI + MariaDB version

Run with XAMPP:
1. Put this folder in C:\xampp\htdocs\
2. Start Apache and MySQL in XAMPP.
3. Import database\pos_database_final.sql in phpMyAdmin.
4. Open http://localhost/POS-System-XAMPP/

Current UI updates:
- Fixed header with navigation beside the Til·POS logo.
- Checkout fits the desktop viewport; only the product list and sale-item list scroll.
- Low-stock notifications use a popup instead of a dedicated Alerts page.
- Admin and Cashier have role-based navigation after login.
- Analytics and Reports support Last 7, 14, 30, and 60 days.
- Product ID is the only product identifier used in the UI and database. SKU is not used.

Demo accounts (after the login update SQL has been applied):
Admin: admin / admin123
Cashier: cashier / cashier123

UI update: Product cards now keep a consistent height after category filtering. Admin-only Add Product uses a modal form, and cashier low-stock popups no longer show the stock management button.


Database setup: import database/tilpos_database.sql as the single SQL file. It creates the tilpos database, tables, demo users, sample products, inventory, vouchers, and reporting views.

Admin: admin / admin123
Cashier: cashier / cashier123
