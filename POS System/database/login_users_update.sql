-- Run this only if the tilpos database already exists and you are not re-importing
-- pos_database_final.sql from scratch.

UPDATE users
SET password_hash = '$2y$12$kC3uVgRo4PXQv3wctA.FKOiUfSkSi.aB8CImRahNjP7I4Nr5svddG'
WHERE username = 'admin';

INSERT INTO users (role_id, username, full_name, email, password_hash)
SELECT r.role_id, 'cashier', 'Store Cashier', 'cashier@tilpos.local',
       '$2y$12$rjJK5VUNNcqE4IrtezXW1.kNJryzjqOzHOhfOPQwZ.EAL0QgNIsSu'
FROM roles r
WHERE r.role_name = 'CASHIER'
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.username = 'cashier');
