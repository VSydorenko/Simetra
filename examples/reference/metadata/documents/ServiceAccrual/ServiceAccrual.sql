-- Рухи «Розрахунків з виконавцями» — запитом, а не конструктором: валюта
-- руху береться розіменуванням договору документа, чого граматика
-- конструктора свідомо не вміє (спека П2 §7).
-- @movements PerformerSettlements
SELECT d.date, 'Receipt', p.performer_id, c.currency_id, p.amount
FROM app.service_accrual_performers p
JOIN app.service_accrual d ON d.id = p.parent_id
JOIN app.contract c ON c.id = d.contract_id
WHERE d.id = p_document_id
ORDER BY p.line_number
-- @end
