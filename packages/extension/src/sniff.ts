// 打包成 sniff.js，由扩展注入到网页的 MAIN world
import { installSniffer } from './sniff-hook.ts';

installSniffer();
