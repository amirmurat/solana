# W9 — технический отчёт

**Автор:** Амир Мурат. **Дата проверки:** 25 октября 2026, Алматы.
**Задание:** Deposit & Share Tokens, commit преподавателя `38db7964441b8b2c62d1d6c9a0457e9434262711`.
**Ветка:** `week9-deposit-share-tokens`. Каталог: `04-deposit-shares`.

## Реализовано

Сохранён каркас W8: initialize, уникальная UserCard, created_at, admin pause/resume и close пустой карточки с возвратом rent. Добавлен SPL-депозит, выпуск share-токенов через PDA-authority, накопительные счётчики vault/карточки, комиссия 1% в фиксированный fee token account, минимум один целый underlying token, запрет депозитов на паузе. Закрытие карточки с историей вкладов запрещено.

Комиссия считается от gross: `floor(amount/100)`. Shares выдаются от net: первый вклад 1:1 в base units, следующие — `floor(net * total_shares / total_tokens)`. Используются checked u64/u128 операции; дробные base units не создаются.

## Реально выполненные проверки

| Проверка                               | Наблюдаемый результат                                                    | Доказательство                                               |
| -------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Rust unit tests                        | **9 passed, 0 failed**, включая Anchor test_id                           | `evidence/rust-tests.txt`                                    |
| Anchor 0.31.1 / Solana CLI 2.1.0 build | **Успешно**, SBF .so и IDL/TypeScript types созданы                      | `evidence/anchor-build-final.txt`                            |
| Развёртывание в localnet               | **Успешно**, настоящий solana-test-validator и upgradeable loader        | Начало `evidence/local-tests.txt`                            |
| Интеграционные тесты W8 + W9           | **34 passed, 0 failed**                                                  | `evidence/local-tests.txt`                                   |
| TypeScript typecheck                   | **Успешно**, `tsc --noEmit` exit 0                                       | `evidence/typecheck.txt` и конец local-tests                 |
| Сценарий трёх пользователей            | **Успешно**: gross 100/50/25, shares 99/49.5/24.75, доли 4:2:1, fee 1.75 | `evidence/three-users.json` и тест                           |
| Devnet genesis                         | Сеть ответила правильным Devnet genesis hash                             | Результат проверки среды в этом отчёте                       |
| Devnet SOL                             | Faucet отклонил запрос; новый кошелёк **0 SOL**                          | `evidence/devnet-airdrop.txt`, `evidence/devnet-balance.txt` |
| Devnet deploy / smoke                  | **Не выполнены**: отсутствует финансирование нового кошелька             | Не выдавать localnet подписи за Devnet                       |
| GitHub Actions                         | **Успешно** для commit `2b91cb6`                | [CI run](https://github.com/amirmurat/solana/actions/runs/40197523054)                  |
| Mainnet                                | Не использовался                                                         | Скрипты ограничены localnet/официальным Devnet               |

Использованы установленный Rust 1.99.1, Solana CLI 2.1.0, Anchor CLI 0.31.1, Node.js 24.22.1. Для штатной IDL-генерации Anchor также установил nightly toolchain. Зависимости закреплены lock-файлами. CI использует Node 22.

## Что проверяют интеграционные тесты

16 унаследованных сценариев W8 плюс 18 W9: decimals 0/9 и минимальный депозит, размеры аккаунтов, три вкладчика, повторный вклад, округление комиссии, zero/below minimum, точный минимум, отсутствие карточки, pause/resume, подмена fee wallet/card/source/destination/mint/reserve, отсутствие подписи, откат всей транзакции при нехватке средств, запрет закрыть профинансированную карточку, прямое пожертвование в reserve, alias fee/source и внешний burn shares.

В сценарии нехватки средств gross=600 токенов: fee-перевод мог бы пройти, но средств на net недостаточно. После отклонения проверяются неизменность source, reserve, fee, supply и счётчиков. Это проверка реальной атомарности CPI, а не только функции арифметики.

## Безопасность и границы модели

| Риск                                   | Принятое решение                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Подмена получателя комиссии            | Адрес записан при initialize, `has_one = fee_wallet`; исходно mint/owner проверены                    |
| Подмена резерва или share mint         | Сохранённый адрес + канонические seeds + mint/authority                                               |
| Чужая карточка / источник / share-счёт | Seeds vault+signer, owner/vault constraints, token authority и signer                                 |
| Self-transfer комиссии                 | Запрещён alias source=fee и fee=reserve                                                               |
| Переполнение / деление на ноль         | u128 intermediate, checked operations/conversion, проверка согласованности totals                     |
| Стирание истории close/recreate        | Карточку с депозитами закрывать нельзя                                                                |
| Прямой transfer в reserve              | Surplus не входит в total_tokens и не меняет курс shares; этот резерв не распределяется автоматически |
| Прямой burn shares                     | Расхождение mint.supply и total_shares возвращает InvalidAccounting; новые депозиты блокируются       |
| Transfer shares другому владельцу      | Разрешён SPL-программой; UserCard — историческая статистика, не текущий баланс прав                   |

Проверка безопасности выполнена по исходникам и автоматическим тестам, это не независимый профессиональный аудит. Вывод средств, восстановление после внешних burn, yield/AMM, Token-2022 и production slippage protection не входят в W9. Donation/burn policy выбрана явно; перед добавлением вывода её нужно пересмотреть вместе с моделью redeemable assets и circulating supply.

## Совместимость

W8-каталог и main не изменены. W9 имеет отдельный Program ID `BjiFbMtqS8a5wj37pTNgGkAuNJ7urYjV1SG6WQxF18AX`. Это проверенный localnet ID, а не Devnet deployment.

Новые поля увеличили VaultState **138 → 194** байта и UserCard **81 → 97**. Старые поля сохранены в прежнем порядке, новые добавлены в конце. Недостаточно просто обновить код W8: старые аккаунты нужно было бы realloc/migrate. Здесь выбран отдельный deployment и новые PDA, без изменения существующей W8.

## Обнаруженные и исправленные проблемы проверки

SBF-инструменты выводят предупреждение о syscall symbols и Anchor deprecated realloc; реальное выполнение initialize/transfer/mint/CPI в 34 успешных тестах подтверждает работоспособность проверенного binary на localnet 2.1.0.

Первый полный suite: 33 passed / 1 failed из-за тестового setup — повторного создания уже существующего ATA для альтернативного fee account. Исправлено явным новым token-account Keypair. Итоговый прогон повторно выполнил весь suite: 34/34.

## Воспроизведение и дальнейшие действия

Команды Linux и структура аккаунтов — README. `bash scripts/test-local.sh` создаёт отдельный ledger и кошелёк (если его нет), пополняет только localnet SOL, разворачивает SBF и запускает suite + typecheck. `anchor keys sync` нужен при создании нового локального program keypair после клонирования.

Для Devnet: пополнить отдельный Devnet wallet, установить `ANCHOR_WALLET` на локальный файл ключа, собрать программу и выполнить `bash scripts/deploy-devnet.sh`; скрипт проверяет сеть, согласованность ID и запрет ID W8. Затем `ANCHOR_PROVIDER_URL=https://api.devnet.solana.com npm run devnet` выполняет smoke с mint/депозитом 100 и сохраняет только публичные результаты. Эти два Devnet шага в данной проверке **не выполнены**. Перед деплоем со свежим program keypair нужны `anchor keys sync` и новая сборка.

Работа технически проверена в localnet. Подтверждения Devnet, выставленной оценки и отправки преподавателю нет. Разбор архитектуры и расчётов — DEFENSE.md.
