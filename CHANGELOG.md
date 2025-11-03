# Changelog

## [1.46.5](https://github.com/zone-eu/wildduck/compare/v1.46.4...v1.46.5) (2025-11-03)


### Bug Fixes

* ZMS-280: bump deps ([#897](https://github.com/zone-eu/wildduck/issues/897)) ([79994f1](https://github.com/zone-eu/wildduck/commit/79994f19e5f8798ed0007730610ef4100b19b00d))

## [1.46.4](https://github.com/zone-eu/wildduck/compare/v1.46.3...v1.46.4) (2025-10-31)


### Bug Fixes

* **threading:** fix threading ([#895](https://github.com/zone-eu/wildduck/issues/895)) ([52d5449](https://github.com/zone-eu/wildduck/commit/52d54492bf5a7c36c7eae96519ee3751daa32d82))

## [1.46.3](https://github.com/zone-eu/wildduck/compare/v1.46.2...v1.46.3) (2025-10-27)


### Bug Fixes

* **addAsync-thread:** ZMSA-2: message addAsync, if a message is referenced then use reference's thread ([#889](https://github.com/zone-eu/wildduck/issues/889)) ([2e89a0e](https://github.com/zone-eu/wildduck/commit/2e89a0e8f0596eb0f9b4b066aa2ee2fc0ee53064))
* **addressregister-migration:** ZMSA-6: improve addressregister migration script ([#892](https://github.com/zone-eu/wildduck/issues/892)) ([de6ee9f](https://github.com/zone-eu/wildduck/commit/de6ee9f072b360d768338856648d16c463a32af7))
* **health:** ZMSA-4: health endpoint also add WD API version ([#890](https://github.com/zone-eu/wildduck/issues/890)) ([35ed9fc](https://github.com/zone-eu/wildduck/commit/35ed9fcfe8e27955b3aeb3ff438ae4e6610d557e))
* **imap-onAppend-logging:** ZMSA-7: onappend logging - parsedHeader.from might not exist ([#894](https://github.com/zone-eu/wildduck/issues/894)) ([27fcd73](https://github.com/zone-eu/wildduck/commit/27fcd730bb8d9dfb9f81f0f764c9cb417ffc211f))
* **threading:** ZMSA-5: if referencing a deleted thread then recreate it ([#893](https://github.com/zone-eu/wildduck/issues/893)) ([7b88109](https://github.com/zone-eu/wildduck/commit/7b8810993c592bacf1294e8aec2da4c9bfe0a113))

## [1.46.2](https://github.com/zone-eu/wildduck/compare/v1.46.1...v1.46.2) (2025-10-17)


### Bug Fixes

* ZMSA-1: update release workflow, update deps, use updated deps, scope package ([#887](https://github.com/zone-eu/wildduck/issues/887)) ([e3d3221](https://github.com/zone-eu/wildduck/commit/e3d3221bd5457400af1b07aad0a7fca80bd66191))

## [1.46.1](https://github.com/zone-eu/wildduck/compare/v1.46.0...v1.46.1) (2025-10-14)


### Bug Fixes

* **imap-append:** ZMS-276: imap append improve logging add new fields to logging ([#884](https://github.com/zone-eu/wildduck/issues/884)) ([6e4b701](https://github.com/zone-eu/wildduck/commit/6e4b701a88edc671c9e8d0f816230fca26e95871))
* **pluginhandler:** ZMS-269: plugins - use wild-plugins, update options, allow for dynamic config ([#886](https://github.com/zone-eu/wildduck/issues/886)) ([479e5bc](https://github.com/zone-eu/wildduck/commit/479e5bcccd1e351f6441216e36f3c9f6150579f4))

## [1.46.0](https://github.com/zone-eu/wildduck/compare/v1.45.13...v1.46.0) (2025-10-07)


### Features

* **deps-node:** ZMS-267: Bump Deps, Update API Docs, Remove support for node v16 and v18 ([#867](https://github.com/zone-eu/wildduck/issues/867)) ([48ee3ea](https://github.com/zone-eu/wildduck/commit/48ee3ead8ca4a33d2cb5bd47181ebd8814588d85))


### Bug Fixes

* **addressregister:** ZMS-268: add new addressregister endpoint to disable an entry or edit it ([#873](https://github.com/zone-eu/wildduck/issues/873)) ([08e5070](https://github.com/zone-eu/wildduck/commit/08e5070f45f8e062bc2bcb75c9ece66c9bdd6313))
* **fulltext-filter:** ZMS-257: Add boolean logic to fulltext filter ([#863](https://github.com/zone-eu/wildduck/issues/863)) ([06569f6](https://github.com/zone-eu/wildduck/commit/06569f6eb93f9fccf6dfb649651158fcec807fbd))
* **messages-search:** ZMS-271: optimize user messages search query ([#876](https://github.com/zone-eu/wildduck/issues/876)) ([63811c7](https://github.com/zone-eu/wildduck/commit/63811c7787b5e254f0b425d326762d05a20ba935))
* **migrations:** ZMS-274 Implement MongoDb Migrations in Wildduck ([#879](https://github.com/zone-eu/wildduck/issues/879)) ([f71972d](https://github.com/zone-eu/wildduck/commit/f71972d1237927326259837c8163604389f9877b))
* **pop3download-log:** ZMS-263: POP3RETR OK also log transferred bytes' size ([#872](https://github.com/zone-eu/wildduck/issues/872)) ([5411118](https://github.com/zone-eu/wildduck/commit/5411118da00db859ec3981f525fab6c51c4b6113))
* **pwned-check:** ZMS-264: Add feature to check password with PwnedPassword API on User Login ([#864](https://github.com/zone-eu/wildduck/issues/864)) ([fb01977](https://github.com/zone-eu/wildduck/commit/fb019774c3dea7f08c7b97e8ac285aabb74bbdf8))
* **search-apply:** ZMS-275: search-apply allow to delete found messages ([#881](https://github.com/zone-eu/wildduck/issues/881)) ([1dc422f](https://github.com/zone-eu/wildduck/commit/1dc422f993a290990618887663d61737880bfa15))
* update api docs ([#880](https://github.com/zone-eu/wildduck/issues/880)) ([a38a704](https://github.com/zone-eu/wildduck/commit/a38a7046c2144622aedd0aabaf4b973036132b86))

## [1.45.13](https://github.com/zone-eu/wildduck/compare/v1.45.12...v1.45.13) (2025-09-11)


### Bug Fixes

* **domaincache:** ZMS-266: domaincache add updates where necessary ([#866](https://github.com/zone-eu/wildduck/issues/866)) ([eef9703](https://github.com/zone-eu/wildduck/commit/eef9703fe0c1c2d0a140abebd0a7c2d6f6b554bb))
* **getmessages:** ZMS-260: messages.js getMessages allow unseen request flag to be false ([#861](https://github.com/zone-eu/wildduck/issues/861)) ([aab6608](https://github.com/zone-eu/wildduck/commit/aab6608119b53dd719a73ed48658ccb39532174b))
* **messages-search:** ZMS-265: messages.js search, allow to search for only seen messages ([#865](https://github.com/zone-eu/wildduck/issues/865)) ([d0bd732](https://github.com/zone-eu/wildduck/commit/d0bd732e1a0a3c8081c6ae5d9c0a34477b7fe462))

## [1.45.12](https://github.com/zone-eu/wildduck/compare/v1.45.11...v1.45.12) (2025-08-22)


### Bug Fixes

* **domaincache-and-domainaliases:** ZMS-259 add wildcard address check when adding domain to mongodb cache ([#859](https://github.com/zone-eu/wildduck/issues/859)) ([4ce3eed](https://github.com/zone-eu/wildduck/commit/4ce3eedd7b7c471cfd60210ab81c62eaa26fad16))
* **on-expunge:** ZMS-255 for client compatability in case no messages were deleted during expunge return no * 0 EXISTS ([#853](https://github.com/zone-eu/wildduck/issues/853)) ([897b4b3](https://github.com/zone-eu/wildduck/commit/897b4b3d67b90f81b5633e4ede8f6b5974e9c3a8))
* **submit-addressregister:** ZMS-256 when submitting draft for delivery update addressregister ([#852](https://github.com/zone-eu/wildduck/issues/852)) ([b0eef8d](https://github.com/zone-eu/wildduck/commit/b0eef8d91742a7af44363f0e877652d5c7048b2e))

## [1.45.11](https://github.com/zone-eu/wildduck/compare/v1.45.10...v1.45.11) (2025-08-01)


### Bug Fixes

* add check for session existence before writing to session writeStream in message-handler ([#843](https://github.com/zone-eu/wildduck/issues/843)) ([95bc33c](https://github.com/zone-eu/wildduck/commit/95bc33c682a549a6f09131da01c180da448b74f8))
* **connection-management:** implement connection management, POP3 timeout fixes, and comprehensive documentation ([#835](https://github.com/zone-eu/wildduck/issues/835)) ([70aed51](https://github.com/zone-eu/wildduck/commit/70aed51373803a2b92fd7fceaa9edf9e3456afad))
* **docker-compose-wd-image:** ZMS-250 use up-to-date wildduck image from GHCR ([#842](https://github.com/zone-eu/wildduck/issues/842)) ([0ce50fd](https://github.com/zone-eu/wildduck/commit/0ce50fdf032690b5acee4033ff7edf2da9630de5))
* **docker-compose:** ZMS-250 update docker-compose, remove CMD_ARGS, use APPCONF in environment variables instead ([#841](https://github.com/zone-eu/wildduck/issues/841)) ([68e83e4](https://github.com/zone-eu/wildduck/commit/68e83e4bedf4c2d8a1dc618d042917e185d9a1cc))
* **docs-attachments:** ZMS-251 add missing fields in the response schema of attachments when fetching messages ([#846](https://github.com/zone-eu/wildduck/issues/846)) ([765c46c](https://github.com/zone-eu/wildduck/commit/765c46cb09d4e4a4828e4e2a858a3ac014784c85))
* **domaincache:** ZMS-247 implement domain cache to store all used domains of users ([#845](https://github.com/zone-eu/wildduck/issues/845)) ([4adfce0](https://github.com/zone-eu/wildduck/commit/4adfce07c389cb25602e64bc4000d96b68ccae90))
* **logging:** ZMS-216 add logs for debugging timeout issue ([#823](https://github.com/zone-eu/wildduck/issues/823)) ([dc56afc](https://github.com/zone-eu/wildduck/commit/dc56afcbda8e6c74b64fb4664761867dfe3e4d82))
* revert recent readme changes, keep only necessary info ([#848](https://github.com/zone-eu/wildduck/issues/848)) ([0f1a55c](https://github.com/zone-eu/wildduck/commit/0f1a55c1c749b738325317c71911d2b4c5ef1da2))
* **setup-script:** ZMS-252 Install script updates ([#847](https://github.com/zone-eu/wildduck/issues/847)) ([c209b3a](https://github.com/zone-eu/wildduck/commit/c209b3af2627da5b6a32b00ca705294d4344392b))

## [1.45.10](https://github.com/zone-eu/wildduck/compare/v1.45.9...v1.45.10) (2025-07-22)


### Bug Fixes

* **addressregister-search:** Make addressregister able to find addresses by domain ZMS-243 ([#832](https://github.com/zone-eu/wildduck/issues/832)) ([5631bd4](https://github.com/zone-eu/wildduck/commit/5631bd4f433bb27202df2e82be16785d343c0b16))
* **addressregister-tests:** add more addressregister tests ZMS-245 ([#834](https://github.com/zone-eu/wildduck/issues/834)) ([213fcb8](https://github.com/zone-eu/wildduck/commit/213fcb8f9744e4e31ac6baa6ed3a2a61766e77b1))
* **docs-response-bimi:** update getMessages endpoint - set the correct bimi response type ZMS-244 ([#831](https://github.com/zone-eu/wildduck/issues/831)) ([60b374e](https://github.com/zone-eu/wildduck/commit/60b374e0073fb5710fe06335dcf2aba52db96f4d))
* **gridstore-downloadstream:** In gridstore download stream ensure that start is never bigger than end ZMS-235 ([#828](https://github.com/zone-eu/wildduck/issues/828)) ([3dfe218](https://github.com/zone-eu/wildduck/commit/3dfe218e19e03ba0b6eeaaa90b79e42962d0bc81))
* **imap-parser:** Rewrite imap-parser, fix common issues ZMS-234 ([#830](https://github.com/zone-eu/wildduck/issues/830)) ([3639d11](https://github.com/zone-eu/wildduck/commit/3639d115d279af05f0098dbd6fec8e153e4cda49))
* **messages.js-tests:** ZMS-228 add initial tests for messages.js endpoints ([#838](https://github.com/zone-eu/wildduck/issues/838)) ([cc3d7b6](https://github.com/zone-eu/wildduck/commit/cc3d7b674b1a8da85c93e3f27da317cfea82a225))

## [1.45.9](https://github.com/zone-eu/wildduck/compare/v1.45.8...v1.45.9) (2025-06-12)


### Bug Fixes

* (workflow): fix api.js, fix release artifacts publishing ZMS-241 ([#826](https://github.com/zone-eu/wildduck/issues/826)) ([8c4af47](https://github.com/zone-eu/wildduck/commit/8c4af475e248b994dda563986027f7f048c6f4ba))

## [1.45.8](https://github.com/zone-eu/wildduck/compare/v1.45.7...v1.45.8) (2025-06-11)


### Bug Fixes

* **deleteMany:** Fix deleteMany callback is not a function. Create async versions of functions ZMS-232 ([#821](https://github.com/zone-eu/wildduck/issues/821)) ([8ada099](https://github.com/zone-eu/wildduck/commit/8ada099d3fbaf56653a15567a5b7676115045662))
* **deploy-zip:** use runner.temp to store temporary files ([#819](https://github.com/zone-eu/wildduck/issues/819)) ([7f5409f](https://github.com/zone-eu/wildduck/commit/7f5409f7907fab9b16151012f60ec965ba341f0e))
* **pagination-paginatedField:** check for correct mongopaging cursor ZMS-229 ([#822](https://github.com/zone-eu/wildduck/issues/822)) ([3c9ecc7](https://github.com/zone-eu/wildduck/commit/3c9ecc760c0acd95d2b19748214f1c8e5bf49a3a))
* ZMS-238 remove callback based deleteMany from attachment storage.  ([#824](https://github.com/zone-eu/wildduck/issues/824)) ([c3a3163](https://github.com/zone-eu/wildduck/commit/c3a3163b1212b283b61bcc00426c78848051d000))
* ZMS-239 parse datestring to isostring when logging request params ([#825](https://github.com/zone-eu/wildduck/issues/825)) ([b026f07](https://github.com/zone-eu/wildduck/commit/b026f07756cc1cea0073565ed9af0ce5a9cad7a5))

## [1.45.7](https://github.com/zone-eu/wildduck/compare/v1.45.6...v1.45.7) (2025-05-27)


### Bug Fixes

* **api-listings-pagination:** ZMS-225 Encode page in next and previous cursor ([#818](https://github.com/zone-eu/wildduck/issues/818)) ([905b463](https://github.com/zone-eu/wildduck/commit/905b463a6336716da0ffdb2c8087660ee13e2686))
* **bulk_batch_size-settingsHandler:** in message handler add bulk_batch_size from settings ([#806](https://github.com/zone-eu/wildduck/issues/806)) ([76f79fd](https://github.com/zone-eu/wildduck/commit/76f79fd274e62da3dffe8a2aac170ba41aecaa2b))
* **moveAsync-addAsync:** use moveAsync and addAsync directly where possible ([#810](https://github.com/zone-eu/wildduck/issues/810)) ([4dcb602](https://github.com/zone-eu/wildduck/commit/4dcb6022d792fb2c51a0a9fe47f8d353e20d4f01))
* **release-workflows:** ZMS-214: Update release workflow. On release upload app bundle to release page ([#808](https://github.com/zone-eu/wildduck/issues/808)) ([c604385](https://github.com/zone-eu/wildduck/commit/c6043858f81d17b51315e40082522ad7ba0055de))
* ZMS 226 ([#817](https://github.com/zone-eu/wildduck/issues/817)) ([bf878ed](https://github.com/zone-eu/wildduck/commit/bf878eda1fc6e3df3bad81d4f586aec5078bfa77))
* **wdr-counter**:  ZMS-224: Count wdr counter after successful message sent not before ([#816](https://github.com/zone-eu/wildduck/issues/816)) ([2f65911](https://github.com/zone-eu/wildduck/commit/2f6591170e6a836580befc8a6517690620b9a94f))

## [1.45.6](https://github.com/zone-eu/wildduck/compare/v1.45.5...v1.45.6) (2025-04-09)


### Bug Fixes

* **addMessage-moveMessage-async-await:** Rewrite addMessage, moveMessage to async/await ZMS-187 ([#779](https://github.com/zone-eu/wildduck/issues/779)) ([d91f112](https://github.com/zone-eu/wildduck/commit/d91f11233118e4b7a7ce43976adedfdbfedc5427))
* **autoreply-test:** fix autoreply PUT test in case of high latency ([#800](https://github.com/zone-eu/wildduck/issues/800)) ([edd9a5b](https://github.com/zone-eu/wildduck/commit/edd9a5baa291e7034428c2d00f62dcd66e49d672))
* **messages-api-timeout:** Add maxTimeMS timeout to mongopaging queries in messages api ZMS-204 ([#799](https://github.com/zone-eu/wildduck/issues/799)) ([3c9aa2a](https://github.com/zone-eu/wildduck/commit/3c9aa2ac00001c4b0e8f293a52d3bb7f9fbda8d2))
* **moveAsync:** ZMS-215: fix incorrect existsEntries and removeEntries clearing in updateMessage() ([#803](https://github.com/zone-eu/wildduck/issues/803)) ([f0f35e1](https://github.com/zone-eu/wildduck/commit/f0f35e1b67e790e51c002cb264b82054056e9d64))
* **outbound-mta-relay:** ZMS-171 Add support for an outbound MTA relay ([#787](https://github.com/zone-eu/wildduck/issues/787)) ([77625e8](https://github.com/zone-eu/wildduck/commit/77625e89d7050653a9589610785820ddc6dc3209))
* **readme-fixes:** Readme fixes and changes ZMS-208 ([#801](https://github.com/zone-eu/wildduck/issues/801)) ([04b2751](https://github.com/zone-eu/wildduck/commit/04b2751f8730ba86d93c97f8c7859fd5d4edc2f7))
* **settingsHandler-bulk_batch_size:** ZMS-218: make BULK_BATCH_SIZE value configurable through settings API ([#804](https://github.com/zone-eu/wildduck/issues/804)) ([730ee79](https://github.com/zone-eu/wildduck/commit/730ee790c9aecd437454661828b0fef47c745819))
* ZMS-210 API and docs fallback values updates ([#802](https://github.com/zone-eu/wildduck/issues/802)) ([5ce9989](https://github.com/zone-eu/wildduck/commit/5ce9989313ae84284b0350c63813c3a448afb9ef))

## [1.45.5](https://github.com/zone-eu/wildduck/compare/v1.45.4...v1.45.5) (2025-03-14)


### Bug Fixes

* Added thread data to EXPUNGE command ([#783](https://github.com/zone-eu/wildduck/issues/783)) ([5ac345e](https://github.com/zone-eu/wildduck/commit/5ac345e060fd719e71ba7a076abcb8d2e1d1d677))
* **api-getMessagesList:** getMessages list, add attachmentsList to response for easier attachment handling ZMS-195 ([#773](https://github.com/zone-eu/wildduck/issues/773)) ([959c707](https://github.com/zone-eu/wildduck/commit/959c70734b2b2c09d232aa21fedf64e8c4aadc20))
* docker-latest workflow updates. Release workflow refactor, add latest tag on release ZMS-205 ([#797](https://github.com/zone-eu/wildduck/issues/797)) ([e6f6920](https://github.com/zone-eu/wildduck/commit/e6f69204493b94d43b65e8f79caafb75ae63b2e8))
* **docker-workflows:** update workflows to only push to GHCR ([#793](https://github.com/zone-eu/wildduck/issues/793)) ([a6de121](https://github.com/zone-eu/wildduck/commit/a6de121d44ef277a6ddc28ae028a9dd10312cf46))
* fixed edge case where `session` not set and uncaught exception occurs ([#780](https://github.com/zone-eu/wildduck/issues/780)) ([8244559](https://github.com/zone-eu/wildduck/commit/82445592301047d0b43992106091d10456ae5611))
* **general-docs-docker:** fix docker general documentation ZMS-197 ([#774](https://github.com/zone-eu/wildduck/issues/774)) ([284ba63](https://github.com/zone-eu/wildduck/commit/284ba638bd633699c8792ba789722dfeb1bdef20))
* **thread-info-expunge-moveTo:** Added thread information to EXPUNGE message called after MoveTo action ([#788](https://github.com/zone-eu/wildduck/issues/788)) ([08c5804](https://github.com/zone-eu/wildduck/commit/08c5804798e7ffe1b281859c4edcec2465d058c2))
* Update all urls in all files to point to new repo url. ZMS-180 ([#791](https://github.com/zone-eu/wildduck/issues/791)) ([37a686d](https://github.com/zone-eu/wildduck/commit/37a686db0899078be9b666e372b49251c6dbe938))
* update and fix docker workflows ([#794](https://github.com/zone-eu/wildduck/issues/794)) ([7e77db7](https://github.com/zone-eu/wildduck/commit/7e77db782f543b037346449592d1ff8c77570dd1))

## [1.45.4](https://github.com/nodemailer/wildduck/compare/v1.45.3...v1.45.4) (2025-01-13)


### Bug Fixes

* **docs-client-gen:** add more readable operationId and response types, fix deps ZMS-188 ([#759](https://github.com/nodemailer/wildduck/issues/759)) ([978ce06](https://github.com/nodemailer/wildduck/commit/978ce0685f3aa2e10f3c3407bb1b9e732e9cf5f2))
* **encrypted-mailboxes:** Add functionality of singular encrypted mailboxes ZMS-181 ([#758](https://github.com/nodemailer/wildduck/issues/758)) ([17bca3e](https://github.com/nodemailer/wildduck/commit/17bca3e9ed21942e37765083d0ac8d5e46379131))
* **imap-indexer:** fix fileContentHash error in imap indexer, check for attachmentInfo beforehand ZMS-186 ([#756](https://github.com/nodemailer/wildduck/issues/756)) ([7daa0e3](https://github.com/nodemailer/wildduck/commit/7daa0e35d5462c46ff4228638f2e9e5f30ed880d))
* **imap-socket-hang:** When allocating IMAP connection, check if socket is still alive ZMS-196 ([#772](https://github.com/nodemailer/wildduck/issues/772)) ([8feae38](https://github.com/nodemailer/wildduck/commit/8feae388367ca8804bb009a8d745e79c64aa9d25))

## [1.45.3](https://github.com/nodemailer/wildduck/compare/v1.45.2...v1.45.3) (2024-11-05)


### Bug Fixes

* **bimi:** Added 'type' for BIMI information schema ([61f03dc](https://github.com/nodemailer/wildduck/commit/61f03dce8f09e23218b4cd90e88568a5cda3c8ff))

## [1.45.2](https://github.com/nodemailer/wildduck/compare/v1.45.1...v1.45.2) (2024-11-05)


### Bug Fixes

* **deps:** Upgraded mailauth for BIMI CMC support ([20f8e9a](https://github.com/nodemailer/wildduck/commit/20f8e9a39f14feda0facfa2ba5c4edb0a550811a))
* **IMAP:** Use a non-round number for socket timeout to decrease race conditions where both the server and the client wait for the same time ([686cd86](https://github.com/nodemailer/wildduck/commit/686cd8644c34c11099752d0d26430080b649edab))

## [1.45.1](https://github.com/nodemailer/wildduck/compare/v1.45.0...v1.45.1) (2024-10-28)


### Bug Fixes

* **api-attachment:** Calculate file content hash when uploading attachment ZMS-172 ([#733](https://github.com/nodemailer/wildduck/issues/733)) ([8730ed5](https://github.com/nodemailer/wildduck/commit/8730ed58f6c7630d63e86bcdc9a755d8904d3df0))
* **api-auth:** /preauth and /authenticate endpoints also return the default address of an user ZMS-175 ([#738](https://github.com/nodemailer/wildduck/issues/738)) ([6dac6ae](https://github.com/nodemailer/wildduck/commit/6dac6ae256ef6d4c555363591392f752cd4e51d3))
* **api-generation:** remove "version" from apigeneration.json ZMS-160 ([#729](https://github.com/nodemailer/wildduck/issues/729)) ([971a0f1](https://github.com/nodemailer/wildduck/commit/971a0f1ba1e66c4fe2bad947d090189be605d21d))
* **api-graylog-req:** Do not use util.inspect if value already string ZMS-174 ([#736](https://github.com/nodemailer/wildduck/issues/736)) ([1a12b03](https://github.com/nodemailer/wildduck/commit/1a12b03a838a6cc2ebba81d13a6a33a8a5591783))
* **api&imap-mailboxes:** Added mailbox subpath and whole path max length limits to API and IMAP ZMS-169 ([#732](https://github.com/nodemailer/wildduck/issues/732)) ([ee870b9](https://github.com/nodemailer/wildduck/commit/ee870b9fed8a344242349fe36581f4894f190c06))
* **deps:** Replaced uuid dependency with crypto.randomUUID ([d462b5a](https://github.com/nodemailer/wildduck/commit/d462b5a55fd470c360d5942bbdb14c13ba6765f0))
* **dockerfile:** Use JSON array for CMD ([6d7d47e](https://github.com/nodemailer/wildduck/commit/6d7d47e9eb61cb7fbdab70b6623a3a7ca0c77fa0))
* **handler-filter:** Filter handler response includes file content sha256 hash ZMS-176 ([#739](https://github.com/nodemailer/wildduck/issues/739)) ([37374be](https://github.com/nodemailer/wildduck/commit/37374be43903737f6c4710537b6fe281fa3ab434))
* **idle:** Fixed IDLE bug with Outlook ([f2c8545](https://github.com/nodemailer/wildduck/commit/f2c8545293277b382b2d357671e9649e9f7c3b9e))
* **log:** Log validation information if command schema validation fails ([1354bf0](https://github.com/nodemailer/wildduck/commit/1354bf0c0508355f77d1fccf8877148513997b29))
* push docker containers to GHCR too ([#746](https://github.com/nodemailer/wildduck/issues/746)) ([2a1b34a](https://github.com/nodemailer/wildduck/commit/2a1b34a2e4c08a29db08b754894228aff5040a78))
* quering for range ZMS-182 ([#742](https://github.com/nodemailer/wildduck/issues/742)) ([3804bea](https://github.com/nodemailer/wildduck/commit/3804bea81eba2e2e865e49f268d072daab630901))
* **readme-copyright:** Add copyright ZMS-180 ([#744](https://github.com/nodemailer/wildduck/issues/744)) ([6542e5b](https://github.com/nodemailer/wildduck/commit/6542e5b09e6b1198490896b9418dae71931be4bd))
* **typos:** fixed typos ZMS-167 ([#740](https://github.com/nodemailer/wildduck/issues/740)) ([36fcabc](https://github.com/nodemailer/wildduck/commit/36fcabcd5b996c5afcc808d6af814d15ac652827))

## [1.45.0](https://github.com/nodemailer/wildduck/compare/v1.44.0...v1.45.0) (2024-08-01)


### Features

* added [@forwardemail](https://github.com/forwardemail) to third-party projects ([#716](https://github.com/nodemailer/wildduck/issues/716)) ([66f8c12](https://github.com/nodemailer/wildduck/commit/66f8c123c37f425ed1eb98aa0eae36c6504b4fd5))


### Bug Fixes

* fixed XAPPLEPUSHSERVICE command (needs to return topic) ([#719](https://github.com/nodemailer/wildduck/issues/719)) ([ba0258f](https://github.com/nodemailer/wildduck/commit/ba0258fc5bc7697ada157f77538eadf667690cd2))
* **lib-filter:** ZMS-161 ([#718](https://github.com/nodemailer/wildduck/issues/718)) ([f32dc14](https://github.com/nodemailer/wildduck/commit/f32dc147e631ac398d5d3a661611e607d2688c47))

## [1.44.0](https://github.com/nodemailer/wildduck/compare/v1.43.3...v1.44.0) (2024-07-29)


### Features

* added base support for XAPPLEPUSHSERVICE (per [#711](https://github.com/nodemailer/wildduck/issues/711)) ([#712](https://github.com/nodemailer/wildduck/issues/712)) ([4e96db2](https://github.com/nodemailer/wildduck/commit/4e96db26ad09aecdd4a80ddb6a1723e06437fa8a))


### Bug Fixes

* **api-addresses:** Main isn't required when updating an address ([#695](https://github.com/nodemailer/wildduck/issues/695)) ([c9188b3](https://github.com/nodemailer/wildduck/commit/c9188b3766b547b091d140a33308b5c3ec3aa1d4))
* **api-all:** Fixes to some API endpoint request and/or response types and schemas ZMS-157 ([#691](https://github.com/nodemailer/wildduck/issues/691)) ([836ca26](https://github.com/nodemailer/wildduck/commit/836ca2601714c2e6337cbbaaaf80e8b5275af821))
* **api-all:** Replaced old documentation with new, autogenerated, one ZMS-154 ([#693](https://github.com/nodemailer/wildduck/issues/693)) ([753997f](https://github.com/nodemailer/wildduck/commit/753997fac7936bd14f564f6773926fc027907a4c))
* **api-endpoints:** public_get and acme endpoints excluded from api docs generation ZMS-156 ([#688](https://github.com/nodemailer/wildduck/issues/688)) ([cc832b2](https://github.com/nodemailer/wildduck/commit/cc832b2da7b008e3b2f3ce739e415f0e684b6de2))
* **api-req_end:** req_end issue fix ZMS-147 ([#681](https://github.com/nodemailer/wildduck/issues/681)) ([ca57ea4](https://github.com/nodemailer/wildduck/commit/ca57ea4897cf0b9bdcac08593005dd54c195c982))
* **api-submit:** Fix submit.js mailboxId and reference request fields ZMS-158 ([#690](https://github.com/nodemailer/wildduck/issues/690)) ([37b6793](https://github.com/nodemailer/wildduck/commit/37b6793976c9d73dc7796bb0f1072472569f4f5b))
* **api-users-updates:** added users/updates api endpoint to api docs generation ZMS-155 ([#687](https://github.com/nodemailer/wildduck/issues/687)) ([490b4e5](https://github.com/nodemailer/wildduck/commit/490b4e5118716107b2b9dcc4c6c74ac00969df1e))
* **api-webhooks:** added all webhook api endpoints to api docs generation ZMS-153 ([#686](https://github.com/nodemailer/wildduck/issues/686)) ([e9abf85](https://github.com/nodemailer/wildduck/commit/e9abf8581f9dcfb2df7b1e317ab0e0e15aa7c4a2))
* **deps:** Bumped deps to clear out some security warnings ([aacf132](https://github.com/nodemailer/wildduck/commit/aacf1326feb0a3323ad0e874c7d4935232eb1084))
* fixed callback invocations to check if session already closed ([#705](https://github.com/nodemailer/wildduck/issues/705)) ([d06071b](https://github.com/nodemailer/wildduck/commit/d06071b8c592944b56a942402e492c9f4eddca0b))
* fixed edge cases when `session` could be `null` ([#699](https://github.com/nodemailer/wildduck/issues/699)) ([a68725d](https://github.com/nodemailer/wildduck/commit/a68725d312b2c1f8684a182531f5dfdfd5ee8e3e))

## [1.43.3](https://github.com/nodemailer/wildduck/compare/v1.43.2...v1.43.3) (2024-05-02)


### Bug Fixes

* **api-storage:** Added all storage endpoints to API docs generation ZMS-149 ([#675](https://github.com/nodemailer/wildduck/issues/675)) ([8e9af88](https://github.com/nodemailer/wildduck/commit/8e9af88a62960207d68f28fb71cd540be7a66fd5))
* **autsni:** Fixed garbage collection for unfinished certificates ([5bf6c86](https://github.com/nodemailer/wildduck/commit/5bf6c865428d743f7ce328647146c95e07f3ace2))

## [1.43.2](https://github.com/nodemailer/wildduck/compare/v1.43.1...v1.43.2) (2024-04-29)


### Bug Fixes

* **SNI:** do not use the default db for SNI ([a6c53eb](https://github.com/nodemailer/wildduck/commit/a6c53eba1fb3a6ed929050742b8681dafc472ce8))

## [1.43.1](https://github.com/nodemailer/wildduck/compare/v1.43.0...v1.43.1) (2024-04-29)


### Bug Fixes

* **api-submit:** Added submission api endpoint to api docs generation ([#676](https://github.com/nodemailer/wildduck/issues/676)) ([82133df](https://github.com/nodemailer/wildduck/commit/82133df0c9b01e9bf4fcfcfea6ed660f37aeffe3))
* **SNI:** disable SNI certificate autogeneration by default ([ecbdc9b](https://github.com/nodemailer/wildduck/commit/ecbdc9be5fefeebc71452f621dcd72e0844955ca))

## [1.43.0](https://github.com/nodemailer/wildduck/compare/v1.42.6...v1.43.0) (2024-04-29)


### Features

* **autoacme:** Allow setting up automatic ACME certificate generation ([cd8596a](https://github.com/nodemailer/wildduck/commit/cd8596a84d36f9870858f3fdc4249f2af42347d9))
* **SNI:** Autogenerate TLS certificates for SNI ([40db519](https://github.com/nodemailer/wildduck/commit/40db519d9c08ebe588a6ce820f6287d4f52f038f))


### Bug Fixes

* **SNI:** delete expired autogenerated SNI certificate ([61c03e1](https://github.com/nodemailer/wildduck/commit/61c03e1725c68fcb0c41e505b4d8cb80b0d73d15))

## [1.42.6](https://github.com/nodemailer/wildduck/compare/v1.42.5...v1.42.6) (2024-04-22)


### Bug Fixes

* **api-ApplicationPassword:** Added all ApplicationPasswords API endpoints to API docs generation ZMS-136 ([#645](https://github.com/nodemailer/wildduck/issues/645)) ([9f9c55a](https://github.com/nodemailer/wildduck/commit/9f9c55a886aa73777ed425680a3fd98dfbe9887f))
* **api-audit:** Added all Audit API endpoints to API docs generation ZMS-135 ([#642](https://github.com/nodemailer/wildduck/issues/642)) ([b9e3f94](https://github.com/nodemailer/wildduck/commit/b9e3f94c6f561dff8598f160aac009adedeb2ec7))
* **api-certs:** Certs API endpoints added to API docs generation ZMS-141 ([#663](https://github.com/nodemailer/wildduck/issues/663)) ([f55ddea](https://github.com/nodemailer/wildduck/commit/f55ddea06df53005aa464378b3229ea0cd140b46))
* **api-dkim:** Fix empty p value in dnsText.value if no private key initially given ZMS-142 ([#664](https://github.com/nodemailer/wildduck/issues/664)) ([d983477](https://github.com/nodemailer/wildduck/commit/d9834776f3afc0895dd36a3b6589ccd4d3b85385))
* **api-domainaccess:** Added all DomainAccess endpoints to api docs generation ZMS-144 ([#670](https://github.com/nodemailer/wildduck/issues/670)) ([c846b66](https://github.com/nodemailer/wildduck/commit/c846b66e170412e44112470242624b64a99dd9dd))
* **api-generate:** API docs generation now is run through a separate npm command ZMS-139 ([#659](https://github.com/nodemailer/wildduck/issues/659)) ([6548f3c](https://github.com/nodemailer/wildduck/commit/6548f3cd5efcf3a768dced5661ef9c61c797a45a))
* **api-messages-attachment-download:** is sendAsString param is set, and is set to true then decode the original file and send back as UTF-8 ZMS-134 ([#655](https://github.com/nodemailer/wildduck/issues/655)) ([1f27778](https://github.com/nodemailer/wildduck/commit/1f27778ae88947027ec613bb3e4f1dd3aff6351f))
* **api-messages-intro:** Take intro from HTML if possible ZMS-112 ([#672](https://github.com/nodemailer/wildduck/issues/672)) ([9d9fbd2](https://github.com/nodemailer/wildduck/commit/9d9fbd25c4b5559e654f7a071c47b42b7856fd74))
* **api-messages:** Added all messages endpoints to api docs generation ZMS-140 ([#666](https://github.com/nodemailer/wildduck/issues/666)) ([6e251c5](https://github.com/nodemailer/wildduck/commit/6e251c5baed520b7e165de514d9308323d1e1ef8))
* **api-messages:** messages fix response types ([#673](https://github.com/nodemailer/wildduck/issues/673)) ([16c6fb8](https://github.com/nodemailer/wildduck/commit/16c6fb8b7c6af0de5d338e5d80d67f0243ea9e25))
* **api-settings:** Added all Settings API endpoints to API docs generation ZMS-145 ([#671](https://github.com/nodemailer/wildduck/issues/671)) ([02a43c6](https://github.com/nodemailer/wildduck/commit/02a43c6330edded905568e178456d1ef44ca14c1))
* **deps:** Bumped deps ([2d0e920](https://github.com/nodemailer/wildduck/commit/2d0e920e0b04b18c4f189bd5835e84af78066b81))

## [1.42.5](https://github.com/nodemailer/wildduck/compare/v1.42.4...v1.42.5) (2024-03-14)


### Bug Fixes

* **roles:** Added new role 'downloader' that can download any email ([4dbc5c5](https://github.com/nodemailer/wildduck/commit/4dbc5c50329f33127edf1949123579ac6a2cc8a7))

## [1.42.4](https://github.com/nodemailer/wildduck/compare/v1.42.3...v1.42.4) (2024-03-14)


### Bug Fixes

* **deploy:** Fixed package-lock for release ([d57a397](https://github.com/nodemailer/wildduck/commit/d57a397fd33da28c86b22887474202fef3c5884b))

## [1.42.3](https://github.com/nodemailer/wildduck/compare/v1.42.2...v1.42.3) (2024-03-14)


### Bug Fixes

* **api-autoreplies:** Added logging to graylog. Autoreply docs have a created field now ZMS-127 ([#633](https://github.com/nodemailer/wildduck/issues/633)) ([f6f5f5e](https://github.com/nodemailer/wildduck/commit/f6f5f5eb65023e8272fbac4d07da1d70070ea5e4))
* **api-domainaliases:** Added DomainAliases API endpoints to API docs generation ZMS-132 ([#641](https://github.com/nodemailer/wildduck/issues/641)) ([5af8126](https://github.com/nodemailer/wildduck/commit/5af8126e549760fb2a0c51be9dff73a16164d44e))
* **api-generation:** api generation package now uses WIldduck Joi and does not depend on fixed joi version ZMS-126 ([#639](https://github.com/nodemailer/wildduck/issues/639)) ([9f704f7](https://github.com/nodemailer/wildduck/commit/9f704f7c5d6bbb99db85c96c2ec494490dc34564))
* **api-quota:** Quota reset now also logs storage diff. Log now includes zero valued fields ZMS-128 ([#640](https://github.com/nodemailer/wildduck/issues/640)) ([64c6b5e](https://github.com/nodemailer/wildduck/commit/64c6b5e63cc7d7fbcc6d17ea0e63108c07bceb78))
* **move:** Extend move operaiton lock automatically ([b1ba513](https://github.com/nodemailer/wildduck/commit/b1ba513a5571f19980283dbec2199171abc09fa0))
* **move:** Increase lock time for moving messages ([b7f0aa6](https://github.com/nodemailer/wildduck/commit/b7f0aa6a22cd8cc57071dce5ed03483b28442ff5))
* **password-hash:** Rehash pbkdf2 if required iterations count increases ([3b7f28c](https://github.com/nodemailer/wildduck/commit/3b7f28c1281b14f5d7e84bd3d630eee96e8dd91f))
* **password-hash:** Update PBKDF2 iteration count to more closely align with OWASP recommendations ([#648](https://github.com/nodemailer/wildduck/issues/648)) ([46654da](https://github.com/nodemailer/wildduck/commit/46654da594a8cca006bcaf93f94d443a04130efd))

## [1.42.2](https://github.com/nodemailer/wildduck/compare/v1.42.1...v1.42.2) (2024-02-26)


### Bug Fixes

* **api-2fa:** Added 2FA API endpoints to API docs generation ZMS-124 ([#626](https://github.com/nodemailer/wildduck/issues/626)) ([0efae19](https://github.com/nodemailer/wildduck/commit/0efae19f9e5d6368ec4121d7f4601df470ebba24))
* **api-addresses:** Fix tags typo in addresses.js ([#627](https://github.com/nodemailer/wildduck/issues/627)) ([7e9e62e](https://github.com/nodemailer/wildduck/commit/7e9e62ea7ae05da7f7b20ec1027df5649c26534e))
* **api-autoreply:** Autoreply API endpoints added to API docs generation ZMS-130 ([#632](https://github.com/nodemailer/wildduck/issues/632)) ([aa60ef9](https://github.com/nodemailer/wildduck/commit/aa60ef93fec943718a5a1fa03494526162cbabed))
* **api-dkim:** Add all DKIM API endpoints to API docs generation ZMS-129 ([#630](https://github.com/nodemailer/wildduck/issues/630)) ([78a9e1b](https://github.com/nodemailer/wildduck/commit/78a9e1b2a8fbc413663716bfe92fe3b2855c54d1))
* **api-dkim:** DKIM now supports ED25519 keys, both in PEM and raw format as input ZMS-125 ([#617](https://github.com/nodemailer/wildduck/issues/617)) ([3d7d0a6](https://github.com/nodemailer/wildduck/commit/3d7d0a6d6a8e38d9e368cc9ffa9abe9c3302b232))
* **api-filters:** Filter creation is now logged to graylog and authlog ZMS-34 ([#616](https://github.com/nodemailer/wildduck/issues/616)) ([6f0e4b5](https://github.com/nodemailer/wildduck/commit/6f0e4b54be9dd83ebd781d3aed204a8934da29fe))
* **git:** Changed git: url in install script to https: ([#610](https://github.com/nodemailer/wildduck/issues/610)) ([5019cf1](https://github.com/nodemailer/wildduck/commit/5019cf13b28dc30b6e1440717fe9ece031da9cba))
* **imap-starttls:** define `SNICallback` only when insecure (closes [#635](https://github.com/nodemailer/wildduck/issues/635)) ([#637](https://github.com/nodemailer/wildduck/issues/637)) ([4b19dee](https://github.com/nodemailer/wildduck/commit/4b19dee20b740f9636ab6a06f1379a4fe5f433fb))
* **pop3-starttls:** ensure default SNICallback option ([f61111e](https://github.com/nodemailer/wildduck/commit/f61111e3cc2d48aaa4ae0ad31e0665caa3db8394))

## [1.42.1](https://github.com/nodemailer/wildduck/compare/v1.42.0...v1.42.1) (2024-02-07)


### Bug Fixes

* **api-filters:** Add Filters API endpoints to API docs generation ZMS-121 ([#611](https://github.com/nodemailer/wildduck/issues/611)) ([95f829d](https://github.com/nodemailer/wildduck/commit/95f829d16aa24883bd763179581b5288acc51f3d))
* **api-generate:** Move API generation code into separate package and use it ZMS-119 ([#613](https://github.com/nodemailer/wildduck/issues/613)) ([c7a1ab4](https://github.com/nodemailer/wildduck/commit/c7a1ab49874ae422c28129f77d5624ccc89af1ff))
* **deps:** downgraded joi to fix conflict with restifyapigenerate ([6724ec9](https://github.com/nodemailer/wildduck/commit/6724ec9f5ecc4ff67ffc8cbc30d42c5bec135ec5))

## [1.42.0](https://github.com/nodemailer/wildduck/compare/v1.41.3...v1.42.0) (2024-02-05)


### Features

* **api-addresses:** ZMS-115 ([#608](https://github.com/nodemailer/wildduck/issues/608)) ([85e09ec](https://github.com/nodemailer/wildduck/commit/85e09ecc772618ea2bccc7912181c6217a6e7b9c))
* **api-health:** Added `/health` endpoint to check Wildduck API health during runtime ZMS-120 ([#607](https://github.com/nodemailer/wildduck/issues/607)) ([84ab0c0](https://github.com/nodemailer/wildduck/commit/84ab0c09dcf915eb29652c49244708703be21b0c))
* **api-mailboxes:** Mailboxes API endpoints added to automatic API docs generation ZMS-114 ([#602](https://github.com/nodemailer/wildduck/issues/602)) ([76d0e8f](https://github.com/nodemailer/wildduck/commit/76d0e8f9e29c09b60129d3c8bacfc1db64328c73))
* **api-search:** Allow searching for messages by uid ([#587](https://github.com/nodemailer/wildduck/issues/587)) ([a4ae3d7](https://github.com/nodemailer/wildduck/commit/a4ae3d7113758d51a9ab04f6ea0bf97fbbcc48c2))
* **api-upload:** Allow to upload a draft message with incorrect (non-emal) `to` addresses ZMS-117 ([#595](https://github.com/nodemailer/wildduck/issues/595)) ([8b7f6c9](https://github.com/nodemailer/wildduck/commit/8b7f6c923ef89fd4391862f3719810b56008ca22))
* **upload:** ZMS-111 ([#584](https://github.com/nodemailer/wildduck/issues/584)) ([6bdeeaa](https://github.com/nodemailer/wildduck/commit/6bdeeaa164fbe125fc9e771c1846386299a0cc26))


### Bug Fixes

* **api-docs:** Fix openapi.yaml so it passes schema validation ([#588](https://github.com/nodemailer/wildduck/issues/588)) ([4a4fb2f](https://github.com/nodemailer/wildduck/commit/4a4fb2feeddcbf799b4fd36554b307b48cf0ace6))
* **api-docs:** Fixed requestBody in API docs ZMS-118 ([#593](https://github.com/nodemailer/wildduck/issues/593)) ([fae91d1](https://github.com/nodemailer/wildduck/commit/fae91d148444029e6f1da101cb15da8d431ce6e4))
* **api-search:** Fixed or query. Fixes [#592](https://github.com/nodemailer/wildduck/issues/592) ([4336554](https://github.com/nodemailer/wildduck/commit/43365542a375433174ea3f8659b4f3ffb0a67732))
* **api:** header.key and header.value not required ZMS-116 ([#582](https://github.com/nodemailer/wildduck/issues/582)) ([29cffe0](https://github.com/nodemailer/wildduck/commit/29cffe0d5f92373d22dc3be0b36543ad0c7a381c))
* **deps:** bumped deps to upgrade mailauth for fixed ed25519 DKIM support ([857e4c0](https://github.com/nodemailer/wildduck/commit/857e4c0a01327d12f87f0017dcf40e2c9967347e))
* **docs:** /users API docs ZMS-110 ([#575](https://github.com/nodemailer/wildduck/issues/575)) ([a15878c](https://github.com/nodemailer/wildduck/commit/a15878c7d709473c5b0d4eec2062e9425c9b5e31))
* **journal-parse:** Improve idle CPU performance ZMS-109 ([#597](https://github.com/nodemailer/wildduck/issues/597)) ([5721047](https://github.com/nodemailer/wildduck/commit/5721047bc1c23b816f08cbf1cba7fbe494724af5))
* **message-threading:** Take non-standard but conventional subject prefixes into account ([#605](https://github.com/nodemailer/wildduck/issues/605)) ([816114f](https://github.com/nodemailer/wildduck/commit/816114f655e34adc15dc27ee13530fdc094b01e0))
* **pop3:** if connection is closed during authentication, then do not process the response. Fixes [#596](https://github.com/nodemailer/wildduck/issues/596) ([eecb31a](https://github.com/nodemailer/wildduck/commit/eecb31ac9a55b6d60a0d5f956375b35a7a5c0363))

## [1.41.3](https://github.com/nodemailer/wildduck/compare/v1.41.2...v1.41.3) (2023-12-19)


### Bug Fixes

* **api:** Remove unnecessary required() that brakes the e-mail send ([#580](https://github.com/nodemailer/wildduck/issues/580)) ([d80ba77](https://github.com/nodemailer/wildduck/commit/d80ba77650f539a47e5a7c28cfd9c9d0de48b3e4))

## [1.41.2](https://github.com/nodemailer/wildduck/compare/v1.41.1...v1.41.2) (2023-12-15)


### Bug Fixes

* **upload:** allow empty name field in the Upload message FROM: header  ZMS-113 ([#577](https://github.com/nodemailer/wildduck/issues/577)) ([c1e28db](https://github.com/nodemailer/wildduck/commit/c1e28db0f3d37b507e7aaef6b26557b27f7ab2f3))

## [1.41.1](https://github.com/nodemailer/wildduck/compare/v1.41.0...v1.41.1) (2023-12-14)


### Bug Fixes

* **defer:** Added new setting const:sender:defer_times ZMS 63 ([#574](https://github.com/nodemailer/wildduck/issues/574)) ([9aab242](https://github.com/nodemailer/wildduck/commit/9aab24267b8c90d7d1af30fcace8c60704e1ea27))
* **mime-parsing:** ensure that text content for multipart nodes always ends with a newline. Fixes [#571](https://github.com/nodemailer/wildduck/issues/571) ([6f4994d](https://github.com/nodemailer/wildduck/commit/6f4994d3a00c8ec73921b443aee4c2cc65561922))

## [1.41.0](https://github.com/nodemailer/wildduck/compare/v1.40.10...v1.41.0) (2023-11-30)


### Features

* **apidocs:** Autogenerate OpenAPI docs ZMS-100 ([#552](https://github.com/nodemailer/wildduck/issues/552)) ([ea24b93](https://github.com/nodemailer/wildduck/commit/ea24b9328b6984db841de86309f1712f100acb97))
* **docs:** ZMS-[9x] Automatic API generation ([#535](https://github.com/nodemailer/wildduck/issues/535)) ([c1cc143](https://github.com/nodemailer/wildduck/commit/c1cc143663bc8ad81794eb9bf4cee04a37937899))
* **mailbox-count-limit:** Set a limit for maximum number of mailbox folders ZMS-93 ([#542](https://github.com/nodemailer/wildduck/issues/542)) ([779bb11](https://github.com/nodemailer/wildduck/commit/779bb11e831eb902330db3ed9056f90aeba4234c))


### Bug Fixes

* **addressregister:** Do not add no-reply addresses to the addressregister ZMS-99 ([#551](https://github.com/nodemailer/wildduck/issues/551)) ([be24af0](https://github.com/nodemailer/wildduck/commit/be24af0d2665fb27f85ff0f0435e4480c21575fa))
* **audit:** Fixed `find()` query for expired audits ([#547](https://github.com/nodemailer/wildduck/issues/547)) ([48b9efb](https://github.com/nodemailer/wildduck/commit/48b9efb8ca4b300597b2e8f5ef4aa307ac97dcfe))
* **docs:** Added support for enums ZMS-104 ([#565](https://github.com/nodemailer/wildduck/issues/565)) ([28bdc76](https://github.com/nodemailer/wildduck/commit/28bdc7621e13a96965a2a24caee873cf15b8aa31))
* **docs:** Fixed descriptions ZMS-101 ([#553](https://github.com/nodemailer/wildduck/issues/553)) ([3c9e175](https://github.com/nodemailer/wildduck/commit/3c9e17595cffd32475f51aa104ab09d721989e6f))
* **imap-search:** rename `headerdate` to `date` (closes [#560](https://github.com/nodemailer/wildduck/issues/560)) ([#561](https://github.com/nodemailer/wildduck/issues/561)) ([fd98244](https://github.com/nodemailer/wildduck/commit/fd98244342089dc8a587e3e45b559f12f8764140))
* **imap:** fixed string conversion to utf8 vs binary (closes [#563](https://github.com/nodemailer/wildduck/issues/563)) ([#564](https://github.com/nodemailer/wildduck/issues/564)) ([ee2708e](https://github.com/nodemailer/wildduck/commit/ee2708e4c150f79745a2a81e3e4555a7549c426d))
* **mailbox-create:** Use correct database for loading User data when creating mailboxes ([#550](https://github.com/nodemailer/wildduck/issues/550)) ([4434cb5](https://github.com/nodemailer/wildduck/commit/4434cb5e1ff4414da874b62997da5ea41892a286))

## [1.40.10](https://github.com/nodemailer/wildduck/compare/v1.40.9...v1.40.10) (2023-10-16)


### Bug Fixes

* **api-filters:** Return valid action.mailbox value for a filter object ([c00cc02](https://github.com/nodemailer/wildduck/commit/c00cc026586fb20eb4509f0d9cc66174bb792c5d))
* **attachments:** Added contentDisposition property for attachments ([292bbc2](https://github.com/nodemailer/wildduck/commit/292bbc28217f6ad271edbcea8416d2bab719726f))
* **imapconnection:** inherit logger and loggelf from server for IMAPConnection ([#533](https://github.com/nodemailer/wildduck/issues/533)) ([667f992](https://github.com/nodemailer/wildduck/commit/667f992ca4bb9f7b50e6f8102ce08f1d3bc0b962))

## [1.40.9](https://github.com/nodemailer/wildduck/compare/v1.40.8...v1.40.9) (2023-10-09)


### Bug Fixes

* **deps:** Bumped nodemailer to force embedded images to content-disposition:inline ([1fee80e](https://github.com/nodemailer/wildduck/commit/1fee80eb30411e9dff73ee762f3528c1c61f9b96))

## [1.40.8](https://github.com/nodemailer/wildduck/compare/v1.40.7...v1.40.8) (2023-10-05)


### Bug Fixes

* **docker:** moved docker release workflow under release workflow ([2641c7e](https://github.com/nodemailer/wildduck/commit/2641c7e7be07fc174d2275a641c05c2da6caa48b))

## [1.40.7](https://github.com/nodemailer/wildduck/compare/v1.40.6...v1.40.7) (2023-10-05)


### Bug Fixes

* **docker:** moved docker release workflow under release workflow ([64be636](https://github.com/nodemailer/wildduck/commit/64be63686fa5a7fe291589b15121c2967801acd6))

## [1.40.6](https://github.com/nodemailer/wildduck/compare/v1.40.5...v1.40.6) (2023-10-05)


### Bug Fixes

* **docker:** moved docker release workflow under release workflow ([8db8d21](https://github.com/nodemailer/wildduck/commit/8db8d212850fdf42a4ae394eff99175e03c535b4))

## [1.40.5](https://github.com/nodemailer/wildduck/compare/v1.40.4...v1.40.5) (2023-10-05)


### Bug Fixes

* **docker:** moved docker release workflow under release workflow ([efbe0dd](https://github.com/nodemailer/wildduck/commit/efbe0dd67306d2c91d2f2737177526b6abaf730d))

## [1.40.4](https://github.com/nodemailer/wildduck/compare/v1.40.3...v1.40.4) (2023-10-05)


### Bug Fixes

* **package:** fixed breaking package lock file ([c008191](https://github.com/nodemailer/wildduck/commit/c0081919fe09dc88617bd80be85c6fe5dcfa05b7))

## [1.40.3](https://github.com/nodemailer/wildduck/compare/v1.40.2...v1.40.3) (2023-10-05)


### Bug Fixes

* **docker:** trying to get release building working ([761f5fa](https://github.com/nodemailer/wildduck/commit/761f5fa18d1260f8dcf5dbb2dcaab078c4d90aab))

## [1.40.2](https://github.com/nodemailer/wildduck/compare/v1.40.1...v1.40.2) (2023-10-05)


### Bug Fixes

* fixed typo validateSequnce &gt; validateSequence (closes [#518](https://github.com/nodemailer/wildduck/issues/518)) ([#520](https://github.com/nodemailer/wildduck/issues/520)) ([8766ab9](https://github.com/nodemailer/wildduck/commit/8766ab9cf50c624d7f1f94ed7136d71387762449))
* **pop3:** run socket.destroy() if pop3 socket is not closed in 1.5s ([2de6c0b](https://github.com/nodemailer/wildduck/commit/2de6c0bc128424e97b53d98239738c9c1c362e0c))

## [1.40.1](https://github.com/nodemailer/wildduck/compare/v1.40.0...v1.40.1) (2023-10-04)


### Bug Fixes

* **debug:** replaced SIGPIPE with SIGHUP to generate snapshots ([7a30ed7](https://github.com/nodemailer/wildduck/commit/7a30ed7861166e92f63e9157f3b1719957cd8520))
* **sending:** Do not count sending limits twice ([#505](https://github.com/nodemailer/wildduck/issues/505)) ([b9349f6](https://github.com/nodemailer/wildduck/commit/b9349f6e8315873668d605e6567ced2d7b1c0c80))

## [1.40.0](https://github.com/nodemailer/wildduck/compare/v1.39.15...v1.40.0) (2023-09-28)


### Features

* **storage:** Added cid property to storage files ([#502](https://github.com/nodemailer/wildduck/issues/502)) ([80797ee](https://github.com/nodemailer/wildduck/commit/80797eebec9f11df3b63b52575609610aa8bfd0c))


### Bug Fixes

* **index:** removed unneeded related_attachments index ([81ec8ca](https://github.com/nodemailer/wildduck/commit/81ec8ca2f59f083c1ded6814ca98076e2e1ee44c))
* **test:** Added POST storage test ([#492](https://github.com/nodemailer/wildduck/issues/492)) ([1c17f5f](https://github.com/nodemailer/wildduck/commit/1c17f5fefc456e95a1f226ca826a273ca07336c4))

## [1.39.15](https://github.com/nodemailer/wildduck/compare/v1.39.14...v1.39.15) (2023-09-05)


### Bug Fixes

* **ci:** Added NPM release workflow ([f4cdbb2](https://github.com/nodemailer/wildduck/commit/f4cdbb2ba5f9607dc6ca521cfcbaaed14d338bef))
* **ci:** Added NPM release workflow ([326ed59](https://github.com/nodemailer/wildduck/commit/326ed59bb94cac6e462b2a503a26eaafd0137093))
* **release:** Added package-lock required for pubslishing ([6b42cc5](https://github.com/nodemailer/wildduck/commit/6b42cc5c289645299d14e08ae42c75aecabf3217))
* **release:** updated repo url for automatic publishing ([48ce200](https://github.com/nodemailer/wildduck/commit/48ce2005be143767f53d8251d0b40e9661c31930))
