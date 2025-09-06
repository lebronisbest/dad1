#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import { Builder, By, Key, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class KoshaApiMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: "kosha-api-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.apiBaseUrl = "https://apis.data.go.kr/B552468/srch/smartSearch";
    this.setupToolHandlers();
  }

  setupToolHandlers() {
    // 도구 목록 제공
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "kosha_search",
            description: "안전보건공단 스마트검색 API를 사용하여 산업안전보건법령, 안전보건 가이드, 기준에 관한 규칙을 검색합니다.",
            inputSchema: {
              type: "object",
              properties: {

                searchValue: {
                  type: "string",
                  description: "검색어 (예: 사다리)",
                },
                category: {
                  type: "string",
                  description: "카테고리 (0: 전체, 1: 산업안전보건법령, 2: 산업안전보건법령 시행령, 3: 산업안전보건법령 시행규칙, 4: 산업안전보건법 기준에 관한 규칙, 5: 고시·훈령·예규, 6: 미디어, 7: KOSHA GUIDE, 8: 중대재해처벌법, 9: 중대재해처벌법 시행령, 11: 화학물질 취급정보의 작업 재해의 관련 규칙)",
                  default: "0"
                },
                pageNo: {
                  type: "string",
                  description: "페이지번호",
                  default: "1"
                },
                numOfRows: {
                  type: "string",
                  description: "한 페이지 결과 수",
                  default: "100"
                }
              },
              required: ["searchValue"],
            },
          },



          {
            name: "kosha_selenium_crawl",
            description: "Selenium WebDriver를 사용하여 KOSHA 포털 페이지를 크롤링하고 파일을 다운로드합니다.",
            inputSchema: {
              type: "object",
              properties: {
                pageUrl: {
                  type: "string",
                  description: "크롤링할 KOSHA 포털 페이지 URL (예: https://portal.kosha.or.kr/archive/cent-archive/master-arch/master-list1/master-detail1?medSeq=44507)",
                },
                downloadPath: {
                  type: "string",
                  description: "다운로드할 폴더 경로 (선택사항, 기본값: ./downloads)",
                  default: "./downloads"
                },
                useHeadless: {
                  type: "boolean",
                  description: "헤드리스 모드 사용 여부 (기본값: false - 브라우저 화면 표시)",
                  default: false
                },
                autoDownload: {
                  type: "boolean",
                  description: "자동 다운로드 여부 (기본값: true)",
                  default: true
                }
              },
              required: ["pageUrl"],
            },
          },
        ],
      };
    });

    // 도구 실행 핸들러
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      switch (name) {
        case "kosha_search":
          return await this.executeKoshaSearch(args);
        case "kosha_selenium_crawl":
          return await this.executeSeleniumCrawl(args);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  // URL에서 파일명과 확장자 추출하는 헬퍼 함수
  extractFileNameFromUrl(url) {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const segments = pathname.split('/');
      let fileName = segments[segments.length - 1];
      
      // 파일명이 없거나 확장자가 없는 경우 기본값 설정
      if (!fileName || !fileName.includes('.')) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        fileName = `kosha_media_${timestamp}.bin`;
      }
      
      return fileName;
    } catch (error) {
      // URL 파싱 실패시 기본 파일명 생성
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      return `kosha_media_${timestamp}.bin`;
    }
  }



  // KOSHA 포털 페이지 크롤링 함수
  async executePageCrawl(args) {
    try {
      const {
        pageUrl,
        downloadPath = "./downloads",
        useHeadless = true,
        autoDownload = true,
        useSelenium = false
      } = args;
      
      // Selenium 사용 옵션이 활성화된 경우
      if (useSelenium) {
        console.log('🔄 Selenium 모드로 전환합니다...');
        try {
          return await this.executeSeleniumCrawl(args);
        } catch (seleniumError) {
          console.log('❌ Selenium 실행 실패, Puppeteer로 fallback:', seleniumError.message);
          // Selenium 실패 시 Puppeteer로 fallback
        }
      }

      // URL 유효성 검증
      if (!pageUrl) {
        throw new Error("pageUrl은 필수 매개변수입니다.");
      }

      let validUrl;
      try {
        validUrl = new URL(pageUrl);
        if (!validUrl.hostname.includes('kosha.or.kr')) {
          throw new Error("KOSHA 포털 도메인이 아닙니다.");
        }
      } catch (error) {
        throw new Error("유효하지 않은 URL입니다.");
      }

      const startTime = Date.now();
      const extractedLinks = [];
      const downloadResults = [];

      // 1. 먼저 KOSHA API로 파일 목록 조회 시도
      const urlParams = new URLSearchParams(pageUrl.split('?')[1] || '');
      const medSeq = urlParams.get('medSeq');
      let apiSuccess = false;
      
      if (medSeq) {
        console.log(`🔍 API 우선 시도: medSeq=${medSeq}`);
        try {
          const apiResult = await this.getFileListFromAPI(medSeq);
          console.log('🔍 API 호출 결과:', JSON.stringify(apiResult, null, 2));
          
                      if (apiResult.success && apiResult.result === 'success') {
            console.log('✅ API로 파일 목록 조회 성공!');
            
            // API 응답에서 파일 정보 추출 (이미지만)
            const files = apiResult.payload || apiResult.data.payload || [];
            if (Array.isArray(files) && files.length > 0) {
              const imageFiles = [];
              files.forEach((file, index) => {
                const fileName = file.orgnlAtchFileNm || file.fileName || file.fileNm || `파일 ${index + 1}`;
                
                // 이미지 파일만 필터링
                if (this.isImageFile(fileName)) {
                  const fileSize = file.atcflSz ? `${(file.atcflSz / (1024 * 1024)).toFixed(2)} MB` : 'Unknown';
                  
                  extractedLinks.push({
                    url: `https://portal.kosha.or.kr/api/portal24/bizV/p/VCPDG01007/downloadFile?atcflNo=${file.atcflNo}`,
                    text: `${fileName} [${fileSize}]`,
                    fileName: fileName,
                    fileSize: fileSize,
                    selector: 'KOSHA_API',
                    type: 'image',
                    method: 'kosha_api_success',
                    fileInfo: file,
                    atcflNo: file.atcflNo,
                    serverFileName: file.atcflSrvrFileNm,
                    serverPath: file.atcflSrvrStrgDtlPathAddr
                  });
                  imageFiles.push(file);
                }
              });
              
              if (imageFiles.length > 0) {
                apiSuccess = true;
                console.log(`✅ API로 ${imageFiles.length}개 이미지 파일 정보 추출 완료 (전체 ${files.length}개 중)`);
              } else {
                console.log('⚠️ API에서 이미지 파일을 찾을 수 없음 - Puppeteer 크롤링으로 전환');
              }
            } else {
              console.log('⚠️ API 응답은 성공했지만 파일 목록이 비어있음 - Puppeteer 크롤링으로 전환');
            }
          } else {
            console.log(`⚠️ API 응답 실패: result=${apiResult.result}, message=${apiResult.message}`);
          }
        } catch (apiError) {
          console.log(`⚠️ API 호출 실패: ${apiError.message}`);
        }
      }

      // 2. API가 실패한 경우에만 Puppeteer 크롤링 시도
      if (!apiSuccess) {
        console.log('🔄 API 실패, Puppeteer 크롤링으로 전환...');
        
        // Puppeteer로 페이지 크롤링 (사람처럼 보이게 설정)
        const browser = await puppeteer.launch({ 
        headless: useHeadless,
        devtools: !useHeadless,
        slowMo: useHeadless ? 0 : 250, // 더 천천히 동작 (사람처럼)
        defaultViewport: { width: 1920, height: 1080 }, // 일반적인 해상도
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox',
          // 봇 감지 우회를 위해 일부 옵션 제거
          '--disable-blink-features=AutomationControlled', // 자동화 감지 비활성화
          '--disable-features=VizDisplayCompositor',
          '--start-maximized',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-infobars',
          '--disable-extensions'
        ]
      });
      
      try {
        const page = await browser.newPage();
        
        // 봇 감지 우회 설정
        await page.evaluateOnNewDocument(() => {
          // webdriver 속성 제거
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
          });
          
          // Chrome 런타임 정보 추가
          window.chrome = {
            runtime: {}
          };
          
          // 권한 API 모킹
          Object.defineProperty(navigator, 'permissions', {
            get: () => ({
              query: () => Promise.resolve({ state: 'granted' }),
            }),
          });
          
          // 플러그인 정보 추가
          Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
          });
        });
        
        // 실제 브라우저와 동일한 User Agent 설정
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // 추가 헤더 설정 (실제 브라우저처럼)
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-User': '?1',
          'Sec-Fetch-Dest': 'document'
        });
        
        // 사람처럼 페이지 접근
        console.log('🌐 페이지 로딩 시작...');
        await page.goto(pageUrl, { 
          waitUntil: 'networkidle0', // 네트워크가 완전히 안정될 때까지 대기
          timeout: 30000
        });
        
        // 사람처럼 스크롤하면서 페이지 확인
        console.log('📜 페이지 스크롤 중 (사람처럼 동작)...');
        await page.evaluate(async () => {
          // 천천히 스크롤 다운
          for (let i = 0; i < 3; i++) {
            window.scrollBy(0, window.innerHeight / 3);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          // 다시 위로
          window.scrollTo(0, 0);
          await new Promise(resolve => setTimeout(resolve, 1000));
        });
        
        // 파일 목록이 로드될 때까지 대기
        try {
          await page.waitForSelector('ul.fileList.detail li', { timeout: 10000 });
          console.log('✅ 파일 목록 로드 완료');
        } catch (error) {
          console.log('⚠️ 파일 목록 로딩 대기 중 타임아웃, 계속 진행...');
        }
        
        // 동적 콘텐츠 로딩 대기 (최적화)
        console.log('⏳ 동적 콘텐츠 로딩 대기 중... (3초)');
        await page.waitForTimeout(3000); // 3초로 단축
        
        // 페이지 내용 가져오기
        const content = await page.content();
        
        // Cheerio로 HTML 파싱
        const $ = cheerio.load(content);
        
        // 이미지 파일 전용 링크 패턴 검색
        const linkSelectors = [
          // 이미지 파일 확장자 링크
          'a[href*=".jpg"]',
          'a[href*=".jpeg"]',
          'a[href*=".png"]',
          'a[href*=".gif"]',
          'a[href*=".bmp"]',
          'a[href*=".svg"]',
          'a[href*=".webp"]',
          'a[href*=".tiff"]',
          'a[href*=".tif"]',
          'a[href*=".ico"]',
          // 이미지 관련 셀렉터
          'img[src]',                  // 이미지 태그 직접
          'a[href*="image"]',          // URL에 image 포함
          'a[href*="img"]',            // URL에 img 포함
          'a[href*="photo"]',          // URL에 photo 포함
          'a[href*="picture"]',        // URL에 picture 포함
          '.image-download',           // 이미지 다운로드 클래스
          '.img-download',
          '.photo-download'
        ];

        // KOSHA 포털 특화 파일 정보 추출
        const fileInfos = [];
        
        // 1. 파일 목록에서 파일 정보 추출 (실제 HTML 구조 기반)
        $('ul.fileList.detail li').each((i, element) => {
          const $element = $(element);
          const $span = $element.find('span').first();
          const downloadBtn = $element.find('button.download').first();
          
          if ($span.length > 0 && downloadBtn.length > 0) {
            const fileText = $span.text().trim();
            
            // 파일명과 크기 추출: "[파일명] [크기]" 형식
            const fileMatch = fileText.match(/^(.+?)\s*\[(.+?)\]$/);
            if (fileMatch && fileMatch[1].includes('.')) { // 실제 파일 확장자가 있는지 확인
              const fileName = fileMatch[1].trim();
              const fileSize = fileMatch[2].trim();
              
              // 이미지 파일만 필터링
              if (this.isImageFile(fileName)) {
                fileInfos.push({
                  fileName: fileName,
                  fileSize: fileSize,
                  text: fileText,
                  downloadButton: downloadBtn,
                  selector: 'ul.fileList.detail li button.download',
                  type: this.getFileTypeFromFileName(fileName)
                });
              }
            }
          }
        });

        // 2. 일반적인 링크 추출 (이미지만)
        linkSelectors.forEach(selector => {
          $(selector).each((i, element) => {
            const $element = $(element);
            
            if (selector === 'img[src]') {
              // img 태그의 src 속성 처리
              const src = $element.attr('src');
              const alt = $element.attr('alt') || '이미지';
              
              if (src) {
                let fullUrl;
                try {
                  fullUrl = new URL(src, pageUrl).toString();
                  const fileName = this.extractFileNameFromUrl(fullUrl);
                  
                  if (this.isImageFile(fileName)) {
                    extractedLinks.push({
                      url: fullUrl,
                      text: alt,
                      fileName: fileName,
                      selector: selector,
                      type: 'image'
                    });
                  }
                } catch (error) {
                  // URL 생성 실패시 무시
                }
              }
            } else {
              // 링크 태그 처리
              const href = $element.attr('href');
              const text = $element.text().trim();
              
              if (href) {
                let fullUrl;
                try {
                  fullUrl = new URL(href, pageUrl).toString();
                  const fileName = this.extractFileNameFromUrl(fullUrl);
                  
                  // 이미지 파일만 필터링
                  if (this.isImageFile(fileName)) {
                    extractedLinks.push({
                      url: fullUrl,
                      text: text || '제목 없음',
                      fileName: fileName,
                      selector: selector,
                      type: 'image'
                    });
                  }
                } catch (error) {
                  // URL 생성 실패시 무시
                }
              }
            }
          });
        });

        // 3. KOSHA API를 통한 파일 목록 조회 시도
        console.log(`📊 파일 정보 개수: ${fileInfos.length}개`);
        console.log(`📊 자동 다운로드 설정: ${autoDownload}`);
        
        // URL에서 medSeq 추출
        const urlParams = new URLSearchParams(pageUrl.split('?')[1] || '');
        const medSeq = urlParams.get('medSeq');
        
        let bulkDownloadResult = null;
        if (medSeq) {
          console.log(`🔍 medSeq: ${medSeq}로 API 호출 시도...`);
          try {
            const apiResult = await this.getFileListFromAPI(medSeq);
            console.log('🔍 API 호출 결과:', JSON.stringify(apiResult, null, 2));
            if (apiResult.success && apiResult.data) {
              console.log('✅ API로 파일 목록 조회 성공!');
              
              // API 응답에서 파일 정보 추출 (이미지만)
              const files = apiResult.data.files || apiResult.data.data || apiResult.data;
              if (Array.isArray(files)) {
                files.forEach((file, index) => {
                  const fileName = file.fileName || file.fileNm || `file_${index + 1}`;
                  
                  // 이미지 파일만 필터링
                  if (this.isImageFile(fileName)) {
                    extractedLinks.push({
                      url: file.downloadUrl || file.fileUrl || `https://portal.kosha.or.kr/api/portal24/bizV/p/VCPDG01007/downloadFile?atcflNo=${file.atcflNo || file.fileId},${index + 1}`,
                      text: fileName,
                      fileName: fileName,
                      fileSize: file.fileSize || file.fileSz || 'Unknown',
                      selector: 'API',
                      type: 'image',
                      method: 'kosha_api',
                      fileInfo: file
                    });
                  }
                });
                
                bulkDownloadResult = { 
                  success: true, 
                  method: 'kosha_api_success',
                  message: `API로 ${files.length}개 파일 정보 조회 완료`,
                  files_count: files.length
                };
              } else {
                console.log('⚠️ API 응답에서 파일 배열을 찾을 수 없음:', apiResult.data);
                bulkDownloadResult = { success: false, error: 'API 응답 형식 불일치' };
              }
            } else {
              console.log('⚠️ API 호출 실패, 브라우저 방식으로 전환');
              bulkDownloadResult = { success: false, error: apiResult.error };
            }
          } catch (apiError) {
            console.log(`⚠️ API 호출 중 오류: ${apiError.message}`);
            bulkDownloadResult = { success: false, error: apiError.message };
          }
        } else {
          console.log('⚠️ URL에서 medSeq를 찾을 수 없음');
          bulkDownloadResult = { success: false, error: 'medSeq 없음' };
        }

        // 4. 전체 다운로드가 실패한 경우만 개별 파일 정보 추출
        if (!bulkDownloadResult || !bulkDownloadResult.success) {
          for (let i = 0; i < fileInfos.length; i++) {
            const fileInfo = fileInfos[i];
            // 단순히 파일 정보만 추출 (실제 다운로드는 나중에 처리)
            extractedLinks.push({
              url: null, // URL은 나중에 생성
              text: fileInfo.text,
              fileName: fileInfo.fileName,
              fileSize: fileInfo.fileSize,
              selector: fileInfo.selector,
              type: fileInfo.type,
              method: 'file_info_extracted',
              downloadButton: fileInfo.downloadButton
            });
          }
        }

        // 중복 제거
        const uniqueLinks = extractedLinks.filter((link, index, self) => 
          index === self.findIndex(l => l.url === link.url)
        );

        // 자동 다운로드 실행 (전체 다운로드가 이미 완료된 경우 제외)
        if (autoDownload && uniqueLinks.length > 0) {
          for (const link of uniqueLinks) {
            try {
              // 이미 전체 다운로드로 완료된 파일은 건너뛰기
              if (link.method === 'browser_download_all' && link.downloadResult) {
                downloadResults.push({
                  ...link,
                  download: {
                    ...link.downloadResult,
                    success: true,
                    message: '전체 다운로드를 통해 이미 완료됨'
                  }
                });
                continue;
              }

              // URL이 없거나 실패한 경우 건너뛰기
              if (!link.url || link.url === 'bulk_download_success') {
                downloadResults.push({
                  ...link,
                  download: {
                    success: false,
                    error: 'URL을 사용할 수 없음 또는 이미 처리됨'
                  }
                });
                continue;
              }

              // 개별 파일 다운로드 (전체 다운로드가 실패한 경우)
              if (link.method === 'file_info_extracted' && link.downloadButton) {
                // 개별 버튼 클릭 시도
                try {
                  await link.downloadButton.click();
                  downloadResults.push({
                    ...link,
                    download: {
                      success: true,
                      message: '개별 다운로드 버튼 클릭 완료 (파일 확인 필요)'
                    }
                  });
                } catch (clickError) {
                  downloadResults.push({
                    ...link,
                    download: {
                      success: false,
                      error: `개별 다운로드 버튼 클릭 실패: ${clickError.message}`
                    }
                  });
                }
                continue;
              }

              // 기존 URL 기반 다운로드
              const fileName = this.extractFileNameFromUrl(link.url) || 
                              link.fileName ||
                              `KOSHA_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.bin`;
              
              const downloadResult = await this.downloadFile(link.url, fileName, downloadPath);
              downloadResults.push({
                ...link,
                download: downloadResult
              });
              
              // 다운로드 간 지연 (서버 부하 방지)
              await new Promise(resolve => setTimeout(resolve, 1000));
              
            } catch (error) {
              downloadResults.push({
                ...link,
                download: {
                  success: false,
                  error: error.message
                }
              });
            }
          }
        }

        } finally {
          await browser.close();
        }
      } // API 실패 시 Puppeteer 크롤링 끝

      const endTime = Date.now();
      const duration = endTime - startTime;

      const result = {
        success: true,
        message: "페이지 크롤링이 완료되었습니다.",
        crawl_info: {
          source_url: pageUrl,
          duration_ms: duration,
          links_found: extractedLinks.length,
          unique_links: extractedLinks.filter((link, index, self) => 
            index === self.findIndex(l => l.url === link.url)
          ).length,
          auto_download_enabled: autoDownload,
          downloads_attempted: downloadResults.length,
          bulk_download_attempted: bulkDownloadResult !== null,
          bulk_download_success: bulkDownloadResult && bulkDownloadResult.success,
          bulk_download_files_count: bulkDownloadResult && bulkDownloadResult.success ? bulkDownloadResult.files_count : 0
        },
        extracted_links: extractedLinks.filter((link, index, self) => 
          index === self.findIndex(l => l.url === link.url)
        ),
        download_results: downloadResults,
        bulk_download_info: bulkDownloadResult
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };

    } catch (error) {
      const errorResult = {
        success: false,
        error: error.message,
        error_type: error.name || 'Error',
        crawl_params: {
          pageUrl: args.pageUrl,
          downloadPath: args.downloadPath || "./downloads",
          useHeadless: args.useHeadless !== false,
          autoDownload: args.autoDownload !== false
        }
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(errorResult, null, 2)
          }
        ]
      };
    }
  }

  // 파일 타입 추출 헬퍼 함수
  getFileTypeFromUrl(url) {
    const extension = url.split('.').pop().toLowerCase().split('?')[0];
    return this.getFileTypeFromExtension(extension);
  }

  // 파일명에서 파일 타입 추출
  getFileTypeFromFileName(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    return this.getFileTypeFromExtension(extension);
  }

  // 확장자에서 파일 타입 매핑
  getFileTypeFromExtension(extension) {
    const typeMap = {
      'mp4': 'video',
      'avi': 'video',
      'mov': 'video',
      'wmv': 'video',
      'pdf': 'document',
      'doc': 'document',
      'docx': 'document',
      'ppt': 'document',
      'pptx': 'document',
      'hwp': 'document',
      'jpg': 'image',
      'jpeg': 'image',
      'png': 'image',
      'gif': 'image',
      'bmp': 'image',
      'svg': 'image',
      'webp': 'image',
      'tiff': 'image',
      'tif': 'image',
      'ico': 'image',
      'mp3': 'audio',
      'wav': 'audio'
    };
    return typeMap[extension] || 'unknown';
  }

  // 이미지 파일인지 확인하는 헬퍼 함수
  isImageFile(fileName) {
    if (!fileName) return false;
    const extension = fileName.split('.').pop().toLowerCase();
    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tiff', 'tif', 'ico'];
    return imageExtensions.includes(extension);
  }

  // KOSHA 포털 다운로드 URL 생성 (정적 방식)
  generateKoshaDownloadUrl(atcflNo, fileIndex = 1) {
    const baseUrl = 'https://portal.kosha.or.kr';
    return `${baseUrl}/api/portal24/bizV/p/VCPDG01007/downloadFile?atcflNo=${atcflNo},${fileIndex}`;
  }

  // atcflNo 추출 (HTML에서 썸네일 URL 패턴 기반)
  extractAtcflNo(content, pageUrl) {
    // URL에서 medSeq 추출
    const urlParams = new URLSearchParams(pageUrl.split('?')[1] || '');
    const medSeq = urlParams.get('medSeq');
    
    if (!medSeq) {
      return null;
    }

    // HTML에서 atcflNo 패턴 찾기
    const atcflMatches = content.match(/atcflNo=([A-Z0-9]+)/g);
    if (atcflMatches && atcflMatches.length > 0) {
      // 첫 번째 atcflNo 사용 (보통 해당 페이지의 메인 콘텐츠)
      const atcflNo = atcflMatches[0].replace('atcflNo=', '');
      return atcflNo;
    }

    return null;
  }

  // 전체 다운로드 버튼을 통한 일괄 다운로드
  async downloadAllFilesViaBrowser(page, downloadPath) {
    try {
      // 다운로드 폴더 설정
      const fullDownloadPath = path.resolve(downloadPath);
      if (!fs.existsSync(fullDownloadPath)) {
        fs.mkdirSync(fullDownloadPath, { recursive: true });
      }

      // 브라우저 다운로드 설정
      await page._client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: fullDownloadPath
      });

      // 다운로드 시작 전 파일 목록 확인
      const beforeFiles = fs.existsSync(fullDownloadPath) ? fs.readdirSync(fullDownloadPath) : [];

      // 전체 다운로드 버튼 찾기 (실제 HTML 구조 기반)
      console.log('🔍 전체 다운로드 버튼 검색 시작...');
      const downloadAllSelectors = [
        'button.downAll', // 실제 HTML에서 확인된 클래스
        'button[class*="downAll"]',
        '.downAll'
      ];

      let downloadAllButton = null;
      
      // 1. 일반적인 셀렉터로 찾기
      for (const selector of downloadAllSelectors) {
        try {
          const buttons = await page.$$(selector);
          if (buttons.length > 0) {
            downloadAllButton = buttons[0];
            console.log(`✅ 전체 다운로드 버튼 발견: ${selector}`);
            break;
          }
        } catch (error) {
          // 계속 다음 셀렉터 시도
        }
      }

      // 2. 텍스트 기반으로 버튼 찾기 (Puppeteer에서 지원하는 방식)
      if (!downloadAllButton) {
        try {
          downloadAllButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button, a'));
            return buttons.find(btn => {
              const text = btn.textContent || btn.innerText || '';
              return text.includes('전체') || text.includes('모두') || text.includes('일괄') || 
                     text.includes('전부') || text.toLowerCase().includes('all');
            });
          });
          
          if (downloadAllButton && downloadAllButton.asElement()) {
            console.log('✅ 텍스트 기반으로 전체 다운로드 버튼 발견');
            downloadAllButton = downloadAllButton.asElement();
          } else {
            downloadAllButton = null;
          }
        } catch (error) {
          console.log('텍스트 기반 버튼 검색 실패:', error.message);
        }
      }

      // 3. 디버깅: 페이지의 모든 버튼 정보 출력
      if (!downloadAllButton) {
        console.log('🔍 페이지의 모든 버튼 정보를 확인합니다...');
        try {
          const allButtons = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
            return buttons.map(btn => ({
              tagName: btn.tagName,
              className: btn.className,
              id: btn.id,
              text: (btn.textContent || btn.innerText || '').trim().substring(0, 50),
              onclick: btn.onclick ? 'has onclick' : 'no onclick',
              href: btn.href || 'no href'
            }));
          });
          
          console.log('📋 발견된 모든 버튼/링크:', JSON.stringify(allButtons, null, 2));
          
          // 다운로드와 관련된 버튼만 필터링
          const downloadRelatedButtons = allButtons.filter(btn => 
            btn.text.includes('다운') || btn.text.includes('down') || 
            btn.className.includes('down') || btn.id.includes('down')
          );
          
          if (downloadRelatedButtons.length > 0) {
            console.log('📥 다운로드 관련 버튼들:', JSON.stringify(downloadRelatedButtons, null, 2));
          }
        } catch (debugError) {
          console.log('디버깅 정보 수집 실패:', debugError.message);
        }
        
        throw new Error('전체 다운로드 버튼을 찾을 수 없습니다. 위의 디버깅 정보를 확인하세요.');
      }

      // 전체 다운로드 버튼 클릭 (여러 방법 시도)
      console.log('🔽 전체 다운로드 시작...');
      try {
        await downloadAllButton.click();
      } catch (clickError) {
        try {
          await downloadAllButton.evaluate(button => button.click());
        } catch (evalError) {
          await page.evaluate(button => {
            const event = new MouseEvent('click', { bubbles: true });
            button.dispatchEvent(event);
          }, downloadAllButton);
        }
      }
      
      // 다운로드 완료 대기 (전체 다운로드는 시간이 더 걸릴 수 있음)
      const maxWaitTime = 60000; // 60초
      const checkInterval = 1000;
      let waitTime = 0;
      let downloadCompleted = false;
      let downloadedFiles = [];

      console.log('⏳ 다운로드 완료 대기 중...');
      while (waitTime < maxWaitTime && !downloadCompleted) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        waitTime += checkInterval;

        if (fs.existsSync(fullDownloadPath)) {
          const afterFiles = fs.readdirSync(fullDownloadPath);
          const newFiles = afterFiles.filter(file => !beforeFiles.includes(file));
          
          // 다운로드 중인 파일(.crdownload, .tmp) 제외
          const completedFiles = newFiles.filter(file => 
            !file.endsWith('.crdownload') && 
            !file.endsWith('.tmp') && 
            !file.endsWith('.part')
          );
          
          if (completedFiles.length > 0) {
            downloadedFiles = completedFiles;
            
            // 일정 시간 동안 새로운 파일이 추가되지 않으면 완료로 간주
            await new Promise(resolve => setTimeout(resolve, 3000));
            const finalFiles = fs.readdirSync(fullDownloadPath).filter(file => 
              !beforeFiles.includes(file) && 
              !file.endsWith('.crdownload') && 
              !file.endsWith('.tmp') && 
              !file.endsWith('.part')
            );
            
            if (finalFiles.length === completedFiles.length) {
              downloadCompleted = true;
              downloadedFiles = finalFiles;
            }
          }
        }

        // 진행 상황 출력
        if (waitTime % 5000 === 0) {
          console.log(`⏳ 다운로드 진행 중... (${waitTime/1000}초 경과)`);
        }
      }

      if (downloadCompleted && downloadedFiles.length > 0) {
        const results = downloadedFiles.map(fileName => {
          const filePath = path.join(fullDownloadPath, fileName);
          const stats = fs.statSync(filePath);
          return {
            file_name: fileName,
            file_path: filePath,
            file_size_bytes: stats.size,
            file_size_mb: (stats.size / (1024 * 1024)).toFixed(2)
          };
        });

        console.log(`✅ 전체 다운로드 완료! ${downloadedFiles.length}개 파일 다운로드됨`);
        return {
          success: true,
          download_method: 'browser_download_all',
          files_count: downloadedFiles.length,
          files: results,
          total_wait_time: waitTime
        };
      } else {
        throw new Error(`다운로드 시간 초과 (${maxWaitTime/1000}초) 또는 파일을 찾을 수 없음`);
      }

    } catch (error) {
      throw new Error(`전체 다운로드 실패: ${error.message}`);
    }
  }

  // KOSHA 포털 다운로드 URL 획득 (개선된 버전)
  async getKoshaDownloadUrl(page, downloadButton, fileName, content, pageUrl) {
    try {
      // 1. 브라우저를 통한 직접 다운로드 시도
      try {
        return await this.downloadFileViaBrowser(page, downloadButton, fileName, './downloads');
      } catch (browserError) {
        console.log(`브라우저 다운로드 실패, 대체 방법 시도: ${browserError.message}`);
      }

      // 2. 정적 방식: atcflNo 기반 URL 생성
      const atcflNo = this.extractAtcflNo(content, pageUrl);
      if (atcflNo) {
        const fileIndex = 1;
        const downloadUrl = this.generateKoshaDownloadUrl(atcflNo, fileIndex);
        return downloadUrl;
      }

      // 3. 대체 방식: 기존 동적 크롤링
      const baseUrl = 'https://portal.kosha.or.kr';
      const possibleUrls = [
        `${baseUrl}/api/portal24/bizV/p/VCPDG01007/downloadFile?fileName=${encodeURIComponent(fileName)}`,
        `${baseUrl}/download/${encodeURIComponent(fileName)}`
      ];

      for (const testUrl of possibleUrls) {
        try {
          const response = await fetch(testUrl, { 
            method: 'HEAD',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });
          if (response.ok) {
            return testUrl;
          }
        } catch (testError) {
          // 계속 다음 URL 시도
        }
      }

      throw new Error('다운로드 URL을 생성할 수 없습니다.');

    } catch (error) {
      throw new Error(`Failed to get download URL for ${fileName}: ${error.message}`);
    }
  }

  // Selenium을 사용한 페이지 크롤링 및 다운로드
  async executeSeleniumCrawl(args) {
    console.log('🚀 Selenium 함수 시작됨');
    try {
      const { pageUrl, downloadPath = './downloads', autoDownload = true, useHeadless = false } = args;
      
      if (!pageUrl) {
        throw new Error("pageUrl은 필수 매개변수입니다.");
      }

      // URL 유효성 검사
      try {
        new URL(pageUrl);
        if (!pageUrl.includes('portal.kosha.or.kr')) {
          throw new Error("KOSHA 포털 URL이 아닙니다.");
        }
      } catch (error) {
        throw new Error("유효하지 않은 URL입니다.");
      }

      const startTime = Date.now();
      const extractedLinks = [];
      const downloadResults = [];

      console.log(`🔍 Selenium으로 페이지 크롤링 시작: ${pageUrl}`);

      // Chrome 옵션 설정 (봇 감지 회피)
      const chromeOptions = new chrome.Options();
      
      // Chrome 바이너리 경로 설정
      chromeOptions.setChromeBinaryPath('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
      
      // 다운로드 설정 (Python 코드와 동일하게)
      chromeOptions.setUserPreferences({
        'download.default_directory': fullDownloadPath,
        'download.prompt_for_download': false,
        'download.directory_upgrade': true,
        'safebrowsing.enabled': true
      });
      
      if (useHeadless) {
        chromeOptions.addArguments('--headless=new');
      }
      
      // 봇 감지 회피를 위한 옵션들
      chromeOptions.addArguments(
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--start-maximized',
        '--window-size=1920,1080',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
      );

      // 다운로드 경로 설정
      const fullDownloadPath = path.resolve(downloadPath);
      if (!fs.existsSync(fullDownloadPath)) {
        fs.mkdirSync(fullDownloadPath, { recursive: true });
      }

      chromeOptions.setUserPreferences({
        'download.default_directory': fullDownloadPath,
        'download.prompt_for_download': false,
        'download.directory_upgrade': true,
        'safebrowsing.enabled': true
      });

      // WebDriver 생성
      const driver = await new Builder()
        .forBrowser('chrome')
        .setChromeOptions(chromeOptions)
        .build();

      try {
        console.log('📱 브라우저 시작됨');
        
        // 봇 감지 회피 스크립트 실행
        await driver.executeScript(`
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
          });
          
          window.chrome = {
            runtime: {},
          };
          
          Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
          });
        `);

        // 페이지 로드
        console.log('🌐 페이지 로드 중...');
        await driver.get(pageUrl);
        
        // 페이지 로드 대기
        await driver.wait(until.titleContains('산업안전포털'), 30000);
        console.log('✅ 페이지 로드 완료');

        // 페이지 로딩 대기 (최적화)
        console.log('⏳ 페이지 로딩 대기 중... (5초)');
        await driver.sleep(5000);

        // 페이지의 모든 버튼 찾기 (디버깅용)
        console.log('🔍 페이지의 모든 버튼 검색 중...');
        const allButtons = await driver.findElements(By.tagName('button'));
        console.log(`📊 총 ${allButtons.length}개의 버튼 발견`);
        
        // 각 버튼의 텍스트와 클래스 확인
        for (let i = 0; i < Math.min(allButtons.length, 10); i++) {
          try {
            const buttonText = await allButtons[i].getText();
            const buttonClass = await allButtons[i].getAttribute('class');
            console.log(`버튼 ${i+1}: "${buttonText}" (class: ${buttonClass})`);
          } catch (err) {
            console.log(`버튼 ${i+1}: 정보 읽기 실패`);
          }
        }

        // Python에서 성공한 방식: button.downAll 직접 시도
        let downloadAllButton = null;
        try {
          console.log('🔍 Python 성공 셀렉터 시도: button.downAll');
          downloadAllButton = await driver.findElement(By.css('button.downAll'));
          console.log('✅ 전체 다운로드 버튼 발견! (Python 방식 성공)');
        } catch (error) {
          console.log('❌ Python 방식 실패, 다른 셀렉터들 시도...');
          
          // 대안 셀렉터들
          const alternativeSelectors = [
            'button[class*="downAll"]',
            'button[onclick*="downAll"]',
            'input[type="button"][value*="전체"]',
            'input[type="button"][value*="다운로드"]'
          ];
          
          for (const selector of alternativeSelectors) {
            try {
              console.log(`🔍 대안 셀렉터 시도: ${selector}`);
              downloadAllButton = await driver.findElement(By.css(selector));
              if (downloadAllButton) {
                console.log(`✅ 전체 다운로드 버튼 발견! (셀렉터: ${selector})`);
                break;
              }
            } catch (selectorError) {
              console.log(`❌ 셀렉터 실패: ${selector}`);
            }
          }
        }
        
        // 텍스트로 버튼 찾기
        if (!downloadAllButton) {
          console.log('🔍 텍스트로 전체 다운로드 버튼 검색 중...');
          try {
            const buttons = await driver.findElements(By.tagName('button'));
            for (const button of buttons) {
              const buttonText = await button.getText();
              if (buttonText.includes('전체') || buttonText.includes('다운로드') || buttonText.includes('모두')) {
                console.log(`✅ 텍스트로 버튼 발견: "${buttonText}"`);
                downloadAllButton = button;
                break;
              }
            }
          } catch (error) {
            console.log('❌ 텍스트 검색 실패:', error.message);
          }
        }
        
        if (downloadAllButton) {
          try {
            console.log('🔽 전체 다운로드 버튼 클릭 시도... (Python 성공 방식)');
            
            // 버튼이 보이도록 스크롤 (Python과 동일)
            await driver.executeScript("arguments[0].scrollIntoView(true);", downloadAllButton);
            await driver.sleep(2000);
            
            // 클릭 시도
            await downloadAllButton.click();
            console.log('✅ 전체 다운로드 버튼 클릭 완료!');
            
            // 다운로드 완료 대기 (최적화)
            console.log('⏳ 다운로드 완료 대기 중 (10초)...');
            await driver.sleep(10000);
            
            extractedLinks.push({
              url: 'bulk_download_success',
              text: '전체 다운로드 버튼 클릭 완료 (Python 방식)',
              fileName: 'bulk_download',
              fileSize: 'Unknown',
              selector: 'python_method_success',
              type: 'bulk',
              method: 'selenium_bulk_download_python_style'
            });
            
          } catch (clickError) {
            console.log('❌ 일반 클릭 실패, JavaScript 클릭 시도...', clickError.message);
            
            // Python과 동일한 JavaScript 클릭 fallback
            try {
              console.log('🔄 JavaScript로 클릭 재시도...');
              await driver.executeScript("arguments[0].click();", downloadAllButton);
              console.log('✅ JavaScript 클릭 성공!');
              await driver.sleep(10000);
              
              extractedLinks.push({
                url: 'bulk_download_success_js',
                text: '전체 다운로드 버튼 JavaScript 클릭 완료',
                fileName: 'bulk_download_js',
                fileSize: 'Unknown',
                selector: 'javascript_click_success',
                type: 'bulk',
                method: 'selenium_bulk_download_js_fallback'
              });
              
            } catch (jsError) {
              console.log('❌ JavaScript 클릭도 실패:', jsError.message);
            }
          }
        } else {
          console.log('⚠️ 전체 다운로드 버튼을 찾을 수 없음');
        }

        // 다운로드 완료 대기 (최적화)
        console.log('⏳ 다운로드 완료 대기 중...');
        await driver.sleep(3000);

      } finally {
        await driver.quit();
        console.log('🔚 브라우저 종료');
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      const result = {
        success: true,
        message: "Selenium 크롤링이 완료되었습니다.",
        crawl_info: {
          source_url: pageUrl,
          duration_ms: duration,
          links_found: extractedLinks.length,
          auto_download_enabled: autoDownload,
          method: 'selenium'
        },
        extracted_links: extractedLinks,
        download_results: downloadResults.length > 0 ? downloadResults : extractedLinks
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };

    } catch (error) {
      const errorResult = {
        success: false,
        error: error.message,
        error_type: error.name || 'Error'
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(errorResult, null, 2)
          }
        ]
      };
    }
  }

  // API 테스트 실행 함수
  async executeApiTest(args) {
    try {
      const { medSeq } = args;
      
      if (!medSeq) {
        throw new Error("medSeq는 필수 매개변수입니다.");
      }

      console.log(`🔍 API 테스트 시작: medSeq=${medSeq}`);
      const result = await this.getFileListFromAPI(medSeq);
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };

    } catch (error) {
      const errorResult = {
        success: false,
        error: error.message,
        error_type: error.name || 'Error'
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(errorResult, null, 2)
          }
        ]
      };
    }
  }

  // KOSHA API를 통한 파일 목록 조회
  async getFileListFromAPI(medSeq) {
    try {
      const apiUrl = 'https://portal.kosha.or.kr/api/portal24/bizA/p/files/getFileList';
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'Content-Type': 'application/json',
          'Origin': 'https://portal.kosha.or.kr',
          'Referer': `https://portal.kosha.or.kr/archive/cent-archive/master-arch/master-list1/master-detail1?medSeq=${medSeq}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
          'chnlid': 'portal24',
          'Cookie': 'WHATAP=z2j0a1thils8tb', // 세션 쿠키 추가
          'sec-ch-ua': '"Chromium";v="138", "Whale";v="4", "Not.A/Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        },
        body: JSON.stringify({
          medSeq: medSeq
        })
      });

      if (!response.ok) {
        throw new Error(`API 호출 실패: HTTP ${response.status}`);
      }

      const data = await response.json();
      console.log('✅ KOSHA API로 파일 목록 조회 성공:', data);
      
      return {
        success: true,
        data: data,
        result: data.result,
        message: data.message,
        payload: data.payload
      };

    } catch (error) {
      console.log('❌ KOSHA API 호출 실패:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 파일 다운로드 헬퍼 함수
  async downloadFile(url, fileName, downloadPath) {
    const fullDownloadPath = path.resolve(downloadPath);
    if (!fs.existsSync(fullDownloadPath)) {
      fs.mkdirSync(fullDownloadPath, { recursive: true });
    }

    const filePath = path.join(fullDownloadPath, fileName);
    const startTime = Date.now();

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://portal.kosha.or.kr/',
        'Origin': 'https://portal.kosha.or.kr'
      },
      timeout: 60000
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const fileStream = fs.createWriteStream(filePath);
    const downloadPromise = new Promise((resolve, reject) => {
      response.body.pipe(fileStream);
      response.body.on('error', reject);
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });

    await downloadPromise;
    const endTime = Date.now();
    const stats = fs.statSync(filePath);

    return {
      success: true,
      file_name: fileName,
      file_path: filePath,
      file_size_bytes: stats.size,
      file_size_mb: (stats.size / (1024 * 1024)).toFixed(2),
      download_duration_ms: endTime - startTime,
      content_type: response.headers.get('content-type') || 'unknown'
    };
  }

  async executeKoshaSearch(args) {
    try {
      const {
        searchValue,
        category = "0",
        pageNo = "1",
        numOfRows = "100"
      } = args;

      // 서비스키 하드코딩
      const serviceKey = "2412dbcc3334b992d01beeb1c5a32b3d7d54c64e9f011056a04edff66e7aeb6b";
                         
      // 필수 매개변수 검증
      if (!serviceKey) {
        throw new Error("serviceKey는 필수 매개변수입니다.");
      }
      if (!searchValue) {
        throw new Error("searchValue는 필수 매개변수입니다.");
      }

      // API URL 구성
      const url = new URL(this.apiBaseUrl);
      url.searchParams.append('serviceKey', serviceKey);
      url.searchParams.append('pageNo', pageNo);
      url.searchParams.append('numOfRows', numOfRows);
      url.searchParams.append('searchValue', searchValue);
      url.searchParams.append('category', category);

      // HTTP 요청 실행
      const startTime = Date.now();
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'MCP-KOSHA-API-Tool/1.0.0',
          'Accept': 'application/json'
        },
        timeout: 30000
      });
      const endTime = Date.now();
      const duration = endTime - startTime;

      // 응답 본문 읽기
      let responseText;
      try {
        responseText = await response.text();
      } catch (error) {
        responseText = `[응답 본문을 읽을 수 없습니다: ${error.message}]`;
      }

      // JSON 파싱 시도
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(responseText);
      } catch (error) {
        parsedResponse = null;
      }

      // 결과 반환
      const result = {
        success: response.ok,
        status_code: response.status,
        status_text: response.statusText,
        duration_ms: duration,
        search_params: {
          searchValue,
          category,
          pageNo,
          numOfRows
        },
        data: parsedResponse || responseText,
        raw_response: responseText
      };

      // 검색 결과 요약 추가
      if (parsedResponse && parsedResponse.response && parsedResponse.response.body) {
        const body = parsedResponse.response.body;
        result.summary = {
          total_count: body.totalCount || 0,
          page_no: body.pageNo || pageNo,
          num_of_rows: body.numOfRows || numOfRows,
          items_count: body.items ? body.items.length : 0
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };

    } catch (error) {
      // 에러 처리
      const errorResult = {
        success: false,
        error: error.message,
        error_type: error.name || 'Error',
        search_params: {
          searchValue: args.searchValue,
          category: args.category || "0",
          pageNo: args.pageNo || "1",
          numOfRows: args.numOfRows || "100"
        }
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(errorResult, null, 2)
          }
        ]
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("KOSHA API MCP Server가 시작되었습니다.");
  }
}

// 서버 시작
const server = new KoshaApiMCPServer();
server.run().catch(console.error);
