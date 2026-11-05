// Так виглядав би вихід кодогену адаптера для одного об'єкта: літерали,
// а не рядки, зібрані в рантаймі. Логічні імена — лише тут, у базі їх немає (Р5).

// Карта логічне → фізичне (для фільтрів і запису) і зворотна (для сигналу).
export const contactColumns = {
  id: 'id',
  organization: 'org_id',
  contactEmail: 'email_addr',
  fullName: 'full_nm',
  company: 'company_id',
  referrer: 'referrer_id',
  score: 'score',
  version: 'row_ver',
} as const;

export const contactPhysicalToLogical = {
  id: 'id',
  org_id: 'organization',
  email_addr: 'contactEmail',
  full_nm: 'fullName',
  company_id: 'company',
  referrer_id: 'referrer',
  score: 'score',
  row_ver: 'version',
} as const;

// Рядок select: аліаси полів, embed з аліасами й підказкою FK.
// `referrer` веде на ту саму таблицю іншим FK — без `!fk_name` embed неоднозначний.
export const contactSelect =
  'id, organization:org_id, contactEmail:email_addr, fullName:full_nm, version:row_ver, score, company:company!contact_company_fk(id, companyTitle:title_txt), referrer:company!contact_referrer_fk(id, companyTitle:title_txt)' as const;
