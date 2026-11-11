/** Fold Vietnamese text into the ASCII form used by the matcher. */
export function foldVietnamese(text) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
}

/** Vietnamese glossary sections grouped by the role facets in skill selection. */
const VI_GLOSSARY_SECTIONS = {
  data: [
    ['phan tich', ['analysis']], ['du lieu', ['data']], ['thong ke', ['statistics']],
    ['phan khuc', ['segmentation']], ['phan doan', ['segmentation']], ['phan tich nhom', ['cohort analysis']],
    ['ty le giu chan', ['retention']], ['giu chan', ['retention']], ['ty le roi bo', ['churn']],
    ['ty le chuyen doi', ['conversion']], ['pheu', ['funnel']],
    ['du bao', ['forecast']], ['thu nghiem', ['experiment']], ['thu nghiem a b', ['a/b test']],
    ['mo hinh du doan', ['predictive model']], ['du doan', ['prediction']], ['tuong quan', ['correlation']],
    ['kham pha du lieu', ['exploratory data analysis']], ['lam sach du lieu', ['data cleaning']],
    ['chat luong du lieu', ['data quality']], ['tap du lieu', ['dataset']], ['so lieu', ['metrics']],
    ['chi so', ['metrics']],
    ['phan bo', ['allocation']], ['tai san', ['assets']], ['tai khoan', ['account']],
    ['giao dich', ['transaction']], ['bao cao tai chinh', ['financial statements']],
    ['chenh lech', ['variance']], ['sai lech', ['discrepancy']], ['file excel', ['xlsx']],
    ['khop so lieu', ['reconciliation']], ['tai lieu', ['document']],
    ['ty le tiet kiem', ['savings rate']], ['gia ban', ['pricing']],
  ],
  engineering: [
    ['lap trinh', ['programming']], ['ky thuat phan mem', ['software engineering']],
    ['ma nguon', ['source code']],
    ['co so du lieu', ['database']], ['di chuyen du lieu', ['migration']], ['xac thuc', ['authentication']],
    ['phan quyen', ['authorization']], ['hieu nang', ['performance']], ['kiem thu', ['testing']],
    ['kiem thu tu dong', ['automated testing']], ['bao mat', ['security']], ['lo hong', ['vulnerability']],
    ['tich hop', ['integration']], ['trien khai', ['deployment']], ['kien truc', ['architecture']],
  ],
  engData: [
    ['kho du lieu', ['data warehouse']], ['mo hinh sao', ['star schema']],
    ['pipeline du lieu', ['data pipeline']], ['dieu phoi', ['orchestration']],
    ['doi soat', ['reconciliation']], ['danh muc su kien', ['event taxonomy']],
    ['bang du lieu', ['table']], ['truy van', ['query']], ['ket noi du lieu', ['data connector']],
  ],
  viz: [
    ['bao cao', ['report']], ['bieu do', ['chart']], ['bang dieu khien', ['dashboard']],
    ['trinh bay', ['presentation']], ['bang tinh', ['spreadsheet']],
    ['truc quan hoa', ['visualization']],
    ['tom tat dieu hanh', ['executive summary']],
  ],
  marketing: [
    ['chien dich', ['campaign']], ['dinh vi', ['positioning']], ['thong diep', ['messaging']],
    ['viet noi dung', ['copywriting']], ['viet bai', ['writing']], ['toi uu tim kiem', ['seo']],
    ['trang dich', ['landing page']], ['mang xa hoi', ['social media']],
    ['giong thuong hieu', ['brand voice']],
    ['lich noi dung', ['content calendar']], ['ra mat', ['launch']], ['quang cao', ['advertising']],
    ['noi dung', ['content']], ['thuong hieu', ['brand']],
  ],
  growth: [
    ['doanh thu tren chi phi quang cao', ['roas']], ['chi phi moi cai dat', ['cpi']],
    ['chi phi thu khach hang', ['cac']],
    ['gia tri vong doi', ['ltv']], ['thoi gian hoan von', ['payback']],
    ['tang truong', ['growth']], ['gia dau thau', ['bidding']], ['ke hoach truyen thong', ['media plan']],
    ['mo hinh phan bo', ['attribution']], ['toi uu ung dung', ['aso']],
    ['hieu qua quang cao', ['performance marketing']],
  ],
  research: [
    ['nghien cuu thi truong', ['market research']], ['quy mo thi truong', ['market sizing']],
    ['doi thu canh tranh', ['competitor']],
    ['doi chieu', ['benchmark']], ['khao sat', ['survey']], ['thiet ke khao sat', ['survey design']],
    ['bang cheo', ['cross-tab']], ['chan dung khach hang', ['persona']], ['phong van', ['interview']],
    ['kich ban gia dinh', ['scenario']], ['gia thuyet', ['hypothesis']],
    ['nghien cuu nguoi dung', ['ux research']],
  ],
  product: [
    ['yeu cau san pham', ['prd']], ['lo trinh', ['roadmap']], ['cong viec ton dong', ['backlog']],
    ['uu tien', ['prioritization']], ['chi so kpi', ['kpi']], ['muc tieu okr', ['okr']],
    ['dinh gia', ['pricing']],
    ['kinh te don vi', ['unit economics']], ['ke hoach', ['planning']], ['pham vi', ['scope']],
    ['san pham', ['product']], ['thi truong', ['market']], ['du an', ['project']],
    ['quan ly du an', ['project management']], ['rui ro', ['risk']], ['lich trinh', ['schedule']],
    ['tien do', ['progress']], ['nhan su du an', ['staffing']], ['nhan vien', ['employee']],
    ['truyen thong noi bo', ['internal communication']], ['thong bao noi bo', ['announcement']],
    ['chinh sach', ['policy']], ['tom tat', ['summary']], ['so sanh', ['comparison']],
    ['danh sach kiem tra', ['checklist']], ['duong gang', ['critical path']],
    ['duong toi han', ['critical path']],
    ['ke hoach nang luc', ['capacity plan']],
    ['bang diem', ['scorecard']],
  ],
  finance: [
    ['luan chung kinh doanh', ['business case']], ['ngan sach', ['budget']],
    ['phan bo ngan sach', ['budget allocation']],
    ['phuong an', ['scenario']], ['danh muc', ['portfolio']],
    ['bien loi nhuan', ['margin']], ['phan tich do nhay', ['sensitivity']],
    ['von luu dong', ['working capital']],
    ['dong tien', ['cash flow']], ['doanh thu', ['revenue']], ['chi phi', ['cost']],
    ['loi nhuan', ['profit']],
    ['diem hoa von', ['break-even']], ['toc do dot tien', ['burn rate']], ['du tru tien mat', ['runway']],
  ],
  accounting: [
    ['ke toan', ['accounting']], ['so sach', ['bookkeeping']], ['but toan', ['journal entry']],
    ['doi chieu so lieu', ['reconciliation']],
    ['he thong tai khoan', ['chart of accounts']], ['ke toan don tich', ['accrual']],
    ['chot so cuoi thang', ['month-end close']],
    ['bao cao ket qua kinh doanh', ['p&l']], ['bang can doi ke toan', ['balance sheet']],
    ['thue gia tri gia tang', ['vat']],
    ['hoa don', ['invoice']], ['so can doi thu', ['trial balance']], ['kiem toan', ['audit']],
    ['trong yeu', ['materiality']],
    ['lay mau', ['sampling']], ['kiem soat noi bo', ['internal controls']],
    ['ho so kiem toan', ['workpapers']],
  ],
  personal: [
    ['tai chinh ca nhan', ['personal finance']], ['ngan sach gia dinh', ['household budget']],
    ['quy khan cap', ['emergency fund']],
    ['tra no', ['debt payoff']], ['tiet kiem', ['savings']], ['lai kep', ['compound interest']],
    ['huu tri', ['retirement']],
    ['gia tri tai san rong', ['net worth']], ['bao hiem', ['insurance']], ['khoan vay', ['loan']],
    ['lai suat', ['interest rate']],
  ],
  operations: [
    ['doanh nghiep nho', ['small business']], ['nha cung cap', ['supplier']], ['ton kho', ['inventory']],
    ['nhap hang', ['procurement']],
    ['san xuat', ['production']], ['nang luc san xuat', ['capacity']],
    ['lich san xuat', ['production scheduling']],
    ['quy trinh chuan', ['sop', 'standard operating procedure']], ['quy trinh', ['process']],
    ['chat luong', ['quality']],
    ['kiem ke', ['inventory']], ['bao tri phong ngua', ['preventive maintenance']],
    ['nguyen nhan goc', ['root cause']],
    ['khong phu hop', ['nonconformance']], ['hoa von', ['break-even']],
    ['cua hang', ['store']], ['ban le', ['retail']], ['dieu khoan thanh toan', ['payment terms']],
    ['tiem tap hoa', ['store']], ['mua ban', ['sales']],
    ['dieu khoan tin dung', ['credit terms']], ['khuyen mai', ['promotion']],
    ['danh sach san pham', ['product listing']],
    ['trang san pham', ['product page']], ['xep hang tim kiem', ['search ranking']], ['tu khoa', ['keyword']],
    ['gio hang', ['shopping cart']], ['gio hang bi bo', ['abandoned cart']],
    ['kiem ke chu ky', ['cycle count']],
    ['ngan keo tien', ['cash drawer']], ['thu ngan', ['cashier']],
    ['nha phan phoi', ['distributor']], ['ro ri bo nho', ['memory leak']],
  ],
  crm: [
    ['pipeline ban hang', ['sales pipeline']], ['khach hang', ['customer']],
    ['khach hang tiem nang', ['lead']], ['danh gia tiem nang', ['lead qualification']],
    ['han ngach', ['quota']], ['du bao ban hang', ['sales forecast']], ['thang thua', ['win loss']],
    ['quan ly quan he khach hang', ['crm']],
    ['ve ho tro', ['ticket']], ['phan loai ve', ['ticket triage']], ['thoa thuan dich vu', ['sla']],
    ['hai long khach hang', ['csat']],
    ['diem nps', ['nps']], ['co so kien thuc', ['knowledge base']],
    ['khieu nai', ['complaint', 'escalation']],
  ],
  people: [
    ['tuyen dung', ['recruiting', 'hiring']], ['mo ta cong viec', ['job description']],
    ['phong van co cau truc', ['structured interview']],
    ['nhan vien moi', ['onboarding']], ['luong thuong', ['compensation']],
    ['danh gia hieu suat', ['performance review']],
    ['khao sat gan ket', ['engagement survey']], ['nghi viec', ['attrition']],
    ['nhan su', ['hr', 'headcount']], ['ung vien', ['candidate']],
    ['quy trinh tuyen dung', ['hiring pipeline']], ['thu moi nhan viec', ['offer']],
    ['ty le nghi viec', ['turnover']],
    ['muc luong', ['salary']], ['khung luong', ['pay band']],
  ],
  legal: [
    ['phap ly', ['legal']], ['hop dong', ['contract']], ['ra soat hop dong', ['contract review']],
    ['bao mat thong tin', ['information security']], ['thoa thuan bao mat', ['nda']],
    ['dieu khoan', ['clause']],
    ['cham dut', ['termination']], ['trach nhiem', ['liability']], ['boi thuong', ['indemnification']],
    ['danh dau sua doi', ['redline']],
    ['tuan thu', ['compliance']], ['du lieu ca nhan', ['data privacy']], ['hai quan', ['customs']],
    ['gia han', ['renewal']],
    ['gian lan', ['fraud']], ['phan tach nhiem vu', ['segregation of duties']],
    ['giay phep phan mem', ['software license']],
    ['lo du lieu', ['data breach']],
  ],
  design: [
    ['thiet ke giao dien', ['ui']], ['trai nghiem nguoi dung', ['ux']],
    ['kiem thu kha dung', ['usability testing']], ['luong nguoi dung', ['user flow']],
    ['khung suon', ['wireframe']], ['kien truc thong tin', ['information architecture']],
    ['kha nang truy cap', ['accessibility']],
    ['chuyen dong', ['motion']], ['he thong thiet ke', ['design system']], ['kieu chu', ['typography']],
    ['khoang cach', ['spacing']],
    ['chan dung nguoi dung', ['persona']], ['nguyen tac heuristic', ['heuristic evaluation']],
    ['nguyen mau', ['prototype']],
  ],
  education: [
    ['muc tieu hoc tap', ['learning objectives']], ['chuong trinh hoc', ['curriculum']],
    ['de cuong khoa hoc', ['syllabus']],
    ['giao an', ['lesson plan']], ['danh gia', ['assessment']], ['hoc truc tuyen', ['e-learning']],
    ['hoi thao', ['workshop']], ['khoang cach ky nang', ['skill gap']], ['dao tao', ['training']],
    ['bang cau hoi', ['survey']],
    ['de cuong', ['course outline']], ['bai kiem tra', ['quiz', 'test']],
    ['kich ban video', ['video script']],
  ],
  realEstate: [
    ['loi suat cho thue', ['rental yield']], ['ty suat von hoa', ['cap rate']], ['thu nhap rong', ['noi']],
    ['loi nhuan tren von tu co', ['cash-on-cash']], ['khoan the chap', ['mortgage']],
    ['khau hao', ['amortization']],
    ['mua hay thue', ['buy vs rent']], ['ty le lap day', ['occupancy']], ['bo trong', ['vacancy']],
    ['bat dong san', ['real estate']],
    ['can ho cho thue', ['apartment']], ['thue nha', ['rental']], ['tien dat coc', ['deposit']],
    ['tra truoc', ['down payment']], ['tai cap von', ['refinance']],
  ],
  logistics: [
    ['hang van chuyen', ['freight']], ['nha van chuyen', ['carrier']], ['ma hs', ['hs code']],
    ['dieu kien thuong mai quoc te', ['incoterms']],
    ['ngoai le giao hang', ['shipment exception']], ['tra hang', ['returns']],
    ['logistics nguoc', ['reverse logistics']],
    ['du bao nhu cau', ['demand planning']], ['ton kho an toan', ['safety stock']],
    ['kho hang', ['warehouse']],
  ],
  localization: [
    ['dich thuat', ['translation']], ['bao ton giong dieu', ['tone preservation']],
    ['dich noi dung', ['translation']],
    ['thich nghi thi truong', ['market adaptation']], ['tieng viet', ['vi-vn']],
    ['ban dia hoa', ['localization']],
  ],
  coverage: [
    ['khoan dau tu', ['investment']], ['danh muc dau tu', ['portfolio']], ['tai san rong', ['net worth']],
    ['tu do tai chinh', ['financial independence']], ['nghi huu som', ['early retirement']],
    ['so cai', ['general ledger']], ['but toan kep', ['double-entry']],
    ['ho tro khach hang', ['customer support']],
  ],
}

/** Frozen folded Vietnamese-to-English domain vocabulary. */
export const VI_GLOSSARY = Object.freeze(
  Object.values(VI_GLOSSARY_SECTIONS).flatMap((entries) => entries.map(
    ([vi, en]) => Object.freeze({ vi: vi.trim(), en: Object.freeze(en) }),
  )),
)

/** Index glossary phrases by their first token, longest phrases first. */
export function buildPhraseIndex(glossary) {
  const index = new Map()
  for (const { vi, en } of glossary) {
    const parts = vi.split(' ')
    const entries = index.get(parts[0]) ?? []
    entries.push({ parts, terms: en })
    index.set(parts[0], entries)
  }
  for (const entries of index.values()) entries.sort((a, b) => b.parts.length - a.parts.length)
  return index
}

const phraseIndex = buildPhraseIndex(VI_GLOSSARY)

function matchesAt(tokens, index, parts) {
  return parts.every((part, offset) => tokens[index + offset]?.[0] === part)
}

/** Translate non-overlapping Vietnamese phrases, longest first, preserving source order. */
export function translateVietnamese(foldedText) {
  // "tỉ lệ" and "tỷ lệ" are spellings of one word; both fold to the glossary's "ty le".
  const normalized = foldedText.replace(/\bti le\b/g, 'ty le')
  const tokens = [...normalized.matchAll(/[a-z0-9]+/g)]
  const consumed = []
  const hits = []
  for (let i = 0; i < tokens.length; i++) {
    const candidates = phraseIndex.get(tokens[i][0]) ?? []
    const match = candidates.find(({ parts }) => matchesAt(tokens, i, parts))
    if (!match) continue
    const endToken = tokens[i + match.parts.length - 1]
    const start = tokens[i].index
    const end = endToken.index + endToken[0].length
    consumed.push([start, end])
    hits.push({ start, end, terms: match.terms })
    i += match.parts.length - 1
  }
  const orderedHits = hits.sort((a, b) => a.start - b.start)
  const terms = orderedHits.flatMap((hit) => hit.terms)
    .filter((term, index, values) => values.indexOf(term) === index)
  return { terms, consumed }
}

/** Return whether text contains Vietnamese-specific letters or a glossary phrase. */
export function isVietnamese(text) {
  return /[ăâđêôơưĂÂĐÊÔƠƯà-ỹÀ-Ỹ]/u.test(text)
    || translateVietnamese(foldVietnamese(text)).terms.length > 0
}
