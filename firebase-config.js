// Firebase の接続先。
// apiKey などはブラウザに公開される前提の値で、パスワードではありません。
// データを守っているのは firestore.rules（セキュリティルール）です。
export const firebaseConfig = {
  apiKey: "AIzaSyDNuBNOszwkPScVOFU1VJYQ4lNB5-Rr7AM",
  authDomain: "family-calendar-95969.firebaseapp.com",
  projectId: "family-calendar-95969",
  storageBucket: "family-calendar-95969.firebasestorage.app",
  messagingSenderId: "1085232477778",
  appId: "1:1085232477778:web:eea09591f575c5eafe518b",
};

// 家族グループの名前（Firestore の families/{FAMILY_ID}）。
export const FAMILY_ID = "home";
