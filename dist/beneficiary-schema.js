export const beneficiaryTypes = {
  FL_RESIDENT: 'Физлицо · резидент',
  FL_NONRESIDENT: 'Физлицо · нерезидент',
  UL_RESIDENT: 'Юрлицо · резидент',
  UL_NONRESIDENT: 'Юрлицо · нерезидент',
  IP_RESIDENT: 'ИП · резидент',
  IP_NONRESIDENT: 'ИП · нерезидент',
  LITE_CONTACT: 'Лёгкий контакт',
};

export const bankTypes = {
  PAYMENT_DETAILS: 'Банковский счёт',
  CARD: 'Карта',
  SBP: 'СБП',
};

export const addressTypes = {
  POSTAL_ADDRESS: 'Почтовый адрес',
  REGISTRATION_ADDRESS: 'Адрес регистрации',
  RESIDENCE_ADDRESS: 'Адрес пребывания',
  LEGAL_ENTITY_ADDRESS: 'Юридический адрес',
  OFFICE_OF_FOREIGN_LEGAL_ENTITY_ADDRESS: 'Адрес представительства иностранной организации',
};

export const documentTypes = {
  PASSPORT: 'Паспорт РФ',
  FOREIGN_PASSPORT: 'Иностранный паспорт',
  FOREIGN_PASSPORT_OF_FOREIGN_CITIZENS: 'Заграничный паспорт иностранного гражданина',
  OFFICIAL_PASSPORT: 'Служебный паспорт',
  DIPLOMATIC_PASSPORT: 'Дипломатический паспорт',
  MIGRATION_CARD: 'Миграционная карта',
  TEMPORARY_RESIDENCE_PERMIT: 'Разрешение на временное проживание',
  VISA: 'Виза',
  RESIDENCE_PERMIT: 'Вид на жительство',
  CONTRACT: 'Трудовой договор',
  CONTRACT_GPD: 'Гражданско-правовой договор',
  PATENT: 'Патент',
};

const field = (key, label, options) => ({ key, label, ...options });
const required = { required: true };
const date = { type: 'date' };
const requiredDate = { ...required, ...date };
const digits = (count) => ({ inputMode: 'numeric', pattern: '\\d{' + count + '}' });

const contactFields = [
  field('phoneNumber', 'Телефон', { type: 'tel', pattern: '\\+[0-9]{7,15}', placeholder: '+79991234567' }),
  field('email', 'Электронная почта', { type: 'email' }),
];
const personFields = [
  field('lastName', 'Фамилия', required),
  field('firstName', 'Имя', required),
  field('middleName', 'Отчество'),
  field('birthDate', 'Дата рождения', requiredDate),
  field('birthPlace', 'Место рождения'),
  field('citizenship', 'Гражданство (код страны)', { ...required, pattern: '[A-Z]{2}', maxLength: 2, placeholder: 'RU' }),
  ...contactFields,
];
const individualFields = [
  ...personFields,
  field('isSelfEmployed', 'Самозанятость', { ...required, type: 'boolean' }),
  field('inn', 'ИНН', digits(12)),
];
const entrepreneurFields = [
  ...personFields,
  field('registrationDate', 'Дата регистрации', requiredDate),
  field('inn', 'ИНН', { ...required, ...digits(12) }),
  field('ogrn', 'ОГРНИП', digits(15)),
];

export const beneficiaryFields = {
  FL_RESIDENT: [...individualFields, field('snils', 'СНИЛС', digits(11))],
  FL_NONRESIDENT: individualFields,
  UL_RESIDENT: [
    field('inn', 'ИНН', { ...required, ...digits(10) }),
    field('name', 'Название организации'),
    ...contactFields,
    field('registrationDate', 'Дата регистрации', date),
    field('opf', 'Организационно-правовая форма'),
    field('ogrn', 'ОГРН', digits(13)),
  ],
  UL_NONRESIDENT: [
    field('name', 'Название организации', required),
    ...contactFields,
    field('registrationDate', 'Дата регистрации', requiredDate),
    field('registrationNumber', 'Регистрационный номер', required),
    field('opf', 'Организационно-правовая форма'),
    field('inn', 'ИНН', digits(10)),
    field('kio', 'Код иностранной организации'),
    field('nza', 'Номер записи об аккредитации'),
  ],
  IP_RESIDENT: entrepreneurFields,
  IP_NONRESIDENT: entrepreneurFields,
  LITE_CONTACT: [],
};

export const addressFields = [
  field('type', 'Тип адреса', { ...required, choices: addressTypes }),
  field('address', 'Адрес', { ...required, maxLength: 256 }),
];

const documentIdentity = [
  field('number', 'Номер документа', required),
  field('date', 'Дата выдачи', requiredDate),
];
const issuer = field('organization', 'Кем выдан', required);
const optionalExpiry = field('expireDate', 'Срок действия', date);
const expiry = { ...optionalExpiry, required: true };

export const documentFields = {
  PASSPORT: [
    field('serial', 'Серия', required),
    ...documentIdentity,
    field('organization', 'Кем выдан'),
    field('division', 'Код подразделения', { ...required, pattern: '\\d{3}-\\d{3}', placeholder: '000-000' }),
  ],
  FOREIGN_PASSPORT: [...documentIdentity, issuer],
  FOREIGN_PASSPORT_OF_FOREIGN_CITIZENS: [...documentIdentity, issuer],
  OFFICIAL_PASSPORT: [...documentIdentity, issuer],
  DIPLOMATIC_PASSPORT: [...documentIdentity, issuer],
  MIGRATION_CARD: [...documentIdentity, expiry],
  TEMPORARY_RESIDENCE_PERMIT: [...documentIdentity, expiry],
  VISA: [...documentIdentity, expiry],
  RESIDENCE_PERMIT: [field('serial', 'Серия'), ...documentIdentity, optionalExpiry],
  CONTRACT: [...documentIdentity, optionalExpiry],
  CONTRACT_GPD: [...documentIdentity, optionalExpiry],
  PATENT: [...documentIdentity, expiry],
};

const isDefault = field('isDefault', 'Реквизиты по умолчанию', { type: 'boolean' });

export const bankFields = {
  PAYMENT_DETAILS: [
    field('bankName', 'Название банка', { ...required, maxLength: 160 }),
    field('bik', 'БИК', { ...required, ...digits(9) }),
    field('accountNumber', 'Номер счёта', { ...required, inputMode: 'numeric', pattern: '(?:\\d{20}|\\d{22})' }),
    field('corrAccountNumber', 'Корреспондентский счёт', { ...required, ...digits(20) }),
    field('name', 'Наименование получателя', { maxLength: 160 }),
    field('inn', 'ИНН получателя', { inputMode: 'numeric', pattern: '(?:\\d{12}|\\d{10}|0)' }),
    field('kpp', 'КПП получателя', { inputMode: 'numeric', pattern: '(?:\\d{9}|0)' }),
    isDefault,
  ],
};

export function validateBeneficiary(data) {
  if (data.type === 'LITE_CONTACT') return;
  if (!data.phoneNumber && !data.email) throw new Error('Укажите телефон или электронную почту.');

  const addresses = data.addresses ?? [];
  if (data.type.startsWith('UL_')) {
    if (data.type === 'UL_NONRESIDENT' && !data.inn && !data.kio) throw new Error('Укажите ИНН или КИО.');
    if ((data.type === 'UL_NONRESIDENT' || addresses.length) && !addresses.some((item) => item.type === 'LEGAL_ENTITY_ADDRESS')) {
      throw new Error('Добавьте юридический адрес.');
    }
    return;
  }

  if (!addresses.some((item) => ['REGISTRATION_ADDRESS', 'RESIDENCE_ADDRESS'].includes(item.type))) {
    throw new Error('Добавьте адрес регистрации или пребывания.');
  }
  const documents = data.documents ?? [];
  if (data.type.endsWith('_NONRESIDENT')) {
    if (data.citizenship === 'BY') {
      if (!documents.some((item) => item.type === 'FOREIGN_PASSPORT')) {
        throw new Error('Для гражданина Беларуси добавьте иностранный паспорт.');
      }
    } else if (documents.length < 2) {
      throw new Error('Добавьте не менее двух документов нерезидента.');
    }
  } else if (!documents.some((item) => item.type === 'PASSPORT')) {
    throw new Error('Добавьте паспорт РФ.');
  }
}
