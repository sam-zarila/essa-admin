// lib/firebase.ts
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDPHV1JfmX9MUWIGwzjCfa9JxqTNzi0_-Y",
  authDomain: "essa-loans.firebaseapp.com",
  projectId: "essa-loans",
  storageBucket: "essa-loans.appspot.com", // use bucket name (not firebasestorage.app domain)
  messagingSenderId: "497714727878",
  appId: "1:497714727878:web:2accb2cb4a2247a26ec0c7",
  // measurementId is optional and only used on client analytics
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
