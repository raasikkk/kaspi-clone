const SESSION_FIELDS = [
  'processId',
  'userToken',
  'tokenSN',
  'tokenSnMac',
  'qrPayTokenSnMac',
  'profileId',
  'phoneNumber',
  'orgName',
  'userId',
  'organizationId',
  'organizationIdn',
  'organizationKbe',
  'empId',
  'accessLevelType',
  'isCashier',
  'payerType',
  'categoryName',
  'possiblePaymentMethods',
  'showFakeCard',
];

export const createEmptySession = () => Object.fromEntries(SESSION_FIELDS.map((k) => [k, null]));

export const sessionFields = () => [...SESSION_FIELDS];

export const applyOrgContext = (session, data) => {
  const cur = data.Current || {};
  session.profileId = cur.ProfileId || session.profileId;
  session.orgName = cur.OrganizationName || session.orgName;
  session.organizationId = cur.OrganizationId || session.organizationId;
  session.organizationIdn = cur.OrganizationIdn || session.organizationIdn;
  session.organizationKbe = cur.OrganizationKbe || session.organizationKbe;
  session.empId = cur.EmpId || session.empId;
  session.accessLevelType = cur.AccessLevelType ?? session.accessLevelType;
  session.isCashier = cur.IsCashier ?? session.isCashier;
  session.payerType = cur.PayerType || session.payerType;
  session.categoryName = cur.CategoryName || session.categoryName;
  session.possiblePaymentMethods = cur.PossiblePaymentMethods || session.possiblePaymentMethods;
  session.showFakeCard = cur.ShowFakeCard ?? session.showFakeCard;
  session.userId = data.UserId || session.userId;
  session.phoneNumber = data.PhoneNumber || session.phoneNumber;
};
