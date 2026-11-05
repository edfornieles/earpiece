plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.edfornieles.earpiece"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.edfornieles.earpiece"
        minSdk = 24
        targetSdk = 34
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
    }

    // CI restores this from protected secrets; the private signing material is never committed.
    val fixedKey = file("mother-signing.p12")
    val signingPassword = System.getenv("MOTHER_SIGNING_PASSWORD")
    signingConfigs {
        if (fixedKey.exists() && !signingPassword.isNullOrEmpty()) create("mother") {
            storeFile = fixedKey
            storeType = "PKCS12"
            storePassword = signingPassword
            keyAlias = "mother"
            keyPassword = signingPassword
        }
    }
    buildTypes {
        getByName("debug") { if (fixedKey.exists() && !signingPassword.isNullOrEmpty()) signingConfig = signingConfigs.getByName("mother") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint { abortOnError = false; checkReleaseBuilds = false }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
