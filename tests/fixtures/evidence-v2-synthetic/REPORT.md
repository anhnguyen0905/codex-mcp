# Báo cáo funnel Sky Courier

## Tóm tắt

Sky Courier của studio hư cấu Cloud Kite có 1.250<!--F1--> potential buyers và 360<!--F2--> actual buyers, tương đương conversion rate 28,80%<!--F3-->. Funnel giữ lại 810<!--F4--> người dùng và có 360<!--F5--> payer.

## Phạm vi và định nghĩa

Phạm vi gồm 10<!--F6--> vùng, 4<!--F7--> kênh thu hút và giai đoạn tháng Ba năm 2031. App id là `com.example.skycourier`; potential buyer là người có ít nhất một lần thử mua, còn actual buyer là người hoàn tất giao dịch. Retention được hiểu là người dùng quay lại trong kỳ.

## Phễu chính

Tỷ lệ actual buyer trên potential buyer là 28,80%<!--F8-->; phần chưa chuyển đổi là 890<!--F9--> người và tỷ lệ này là 71,20%<!--F10-->. Retention đạt 64,80%<!--F11--> trên 1.250<!--F12--> người, còn payer chiếm 28,80%<!--F13--> của potential buyer. Số actual buyer cao hơn mốc thử nghiệm tối thiểu 300<!--F14--> người.

## Vì sao chưa mua

Ba nhóm lý do có tổng 880<!--F15--> lượt. ReasonA chiếm 46,59%<!--F16--> với 410<!--F17--> lượt, ReasonB chiếm 32,50%<!--F18--> với 286<!--F19--> lượt, còn ReasonC chiếm 20,91%<!--F20--> với 184<!--F21--> lượt.

## Theo vùng

R03 có conversion rate 25,00%<!--F22--> từ 120<!--F23--> potential buyers và 30<!--F24--> actual buyers. R10 đạt conversion rate 57,93%<!--F25--> với 145<!--F26--> potential buyers và 84<!--F27--> actual buyers.

Bảng vùng <!--T1-->
| Vùng | Potential | Actual | CR |
| --- | ---: | ---: | ---: |
| R01 | 140 | 48 | 34.29 |
| R02 | 130 | 39 | 30.00 |
| R03 | 120 | 30 | 25.00 |
| R04 | 115 | 29 | 25.22 |
| R05 | 110 | 28 | 25.45 |
| R06 | 105 | 27 | 25.71 |
| R07 | 100 | 26 | 26.00 |
| R08 | 95 | 25 | 26.32 |
| R09 | 90 | 24 | 26.67 |
| R10 | 145 | 84 | 57.93 |
| Other | 100 | 0 | 0.00 |

## Theo kênh

Organic có conversion rate 31,90%<!--F28--> và 134<!--F29--> actual buyers; paid search có 78<!--F30--> actual buyers.

Bảng kênh <!--T2-->
| Kênh | Potential | Actual | CR |
| --- | ---: | ---: | ---: |
| organic | 420 | 134 | 31.90 |
| paid_search | 310 | 78 | 25.16 |
| social | 280 | 70 | 25.00 |
| referral | 240 | 78 | 32.50 |

## Theo SKU

bundle_a dẫn đầu với 92<!--F31--> orders và share 25,56%<!--F32-->; bundle_h có 6<!--F33--> orders.

Bảng SKU <!--T3-->
| SKU | Orders | Share |
| --- | ---: | ---: |
| bundle_a | 92 | 25.56 |
| bundle_b | 78 | 21.67 |
| bundle_c | 65 | 18.06 |
| bundle_d | 52 | 14.44 |
| bundle_e | 35 | 9.72 |
| bundle_f | 22 | 6.11 |
| bundle_g | 10 | 2.78 |
| bundle_h | 6 | 1.67 |

## Theo lifecycle

Nhóm new day four-to-seven có conversion rate 35,00%<!--F34-->; nhóm new day zero có 500<!--F35--> potential buyers.

Bảng lifecycle <!--T4-->
| Bucket | Potential | Actual | CR |
| --- | ---: | ---: | ---: |
| new_day_0 | 500 | 120 | 24.00 |
| new_day_1_3 | 360 | 108 | 30.00 |
| new_day_4_7 | 240 | 84 | 35.00 |
| new_day_8_plus | 150 | 48 | 32.00 |

## First-time và repeat

First-time buyer là 285<!--F36--> người và repeat buyer là 75<!--F37--> người, tương ứng 79,17%<!--F38--> và 20,83%<!--F39-->.

Bảng buyer type <!--T5-->
| Buyer type | Buyers | Share |
| --- | ---: | ---: |
| first_time | 285 | 79.17 |
| repeat | 75 | 20.83 |

## Attempts trước khi mua

Có 190<!--F40--> buyer mua sau một lần thử; nhóm four plus là 26<!--F41--> buyer.

Bảng attempts <!--T6-->
| Attempts | Buyers | Share |
| --- | ---: | ---: |
| one | 190 | 52.78 |
| two | 96 | 26.67 |
| three | 48 | 13.33 |
| four_plus | 26 | 7.22 |

## Time to purchase

144<!--F42--> buyer hoàn tất dưới ten phút và 10,00%<!--F43--> không hoàn tất.

Bảng time to purchase <!--T7-->
| Outcome | Buyers | Share |
| --- | ---: | ---: |
| under_10_min | 144 | 40.00 |
| 10_30_min | 126 | 35.00 |
| over_30_min | 54 | 15.00 |
| not_completed | 36 | 10.00 |

## Tổng hợp theo SKU và vùng

Bảng tổng hợp SKU cho thấy bundle_b có 78<!--F44--> orders; vùng R01 có 48<!--F45--> actual buyers.

Bảng phạm vi <!--T8-->
| Scope | App | Start | End | Regions | Channels |
| --- | --- | --- | --- | ---: | ---: |
| all | com.example.skycourier | 2031-03-01 | 2031-03-14 | 10 | 4 |

## Đề xuất

Ưu tiên cải thiện onboarding cho nhóm new day zero, thử thông điệp cho ReasonA và theo dõi conversion rate theo vùng. Mục tiêu quý là tăng actual buyer thêm 40<!--F46--> người và giữ retention trên 60,00%<!--F47-->.
